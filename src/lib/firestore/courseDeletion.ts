import "server-only";
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import {
  courseRunChannel,
  normalizeCourse,
  normalizeCourseRun,
  type CourseDoc,
  type CourseRunDoc,
} from "./courses";
import { COURSE_MATERIAL_NOTES_COLLECTION } from "./courseMaterialNotes";
import { deleteEventsForSubscriptions } from "./subscriptions";
import { ownedStoragePaths } from "./taskAttachments";

/**
 * DESTROY — the irreversible half of the courses deletion protocol (v2 plan,
 * decision 12). Archive is the everyday path; this module is the generalised
 * `accountDeletion.ts` machinery pointed at a course run (or, once every run
 * is gone, a course): admin-only, typed-confirmation at the route, live-count
 * manifest, audit record FIRST, and a resumable paginated cascade.
 *
 * The audit row (`courseDeletions/{auditId}`) is created BEFORE anything is
 * deleted, in the same transaction that marks the run doc — so an audit row
 * with `completedAt: null` is durable evidence of an interrupted destroy, the
 * exact crash-safety property the impersonation log and accountDeletion's
 * keep-the-tracker-row rule both encode. All writes here are Admin SDK;
 * clients get admin READ only (rules owned by the rules suite).
 *
 * RESUMABILITY. Each invocation spends a fixed document budget
 * (`DESTROY_DOC_BUDGET`) and returns `complete: false` when it runs out; the
 * SAME call repeated resumes, because:
 *  - every collection is drained with delete-as-you-read pagination (the
 *    `deleteOwnedCourseRows` pattern): the next query's first page IS the
 *    next unprocessed page, so there is no cursor to persist;
 *  - the run doc is deleted LAST — while it exists, a resumed cascade can
 *    still find everything (the `runId` on every leaf row, the cohort
 *    channel, and the `destroyAuditId` marker that names the audit row to
 *    keep accumulating into);
 *  - the audit row accumulates per-collection counts across invocations, and
 *    each invocation REPORTS those accumulated totals (it reads the row back
 *    after its own increments land) — a resume can start in a different tab
 *    from the one that began the cascade, and only the server can state what
 *    the whole destroy has removed.
 *
 * ONE PASS AT A TIME (`passInFlightUntil`). Two invocations overlapping on the
 * same audit row would both increment it over the same pages — the totals
 * above stop being exact the moment that happens. So each pass CLAIMS the
 * audit row for `PASS_LEASE_MS` inside the same transaction that finds or
 * opens it, and a second invocation arriving inside that window is refused
 * (`DestroyPassInFlightError` → 409) rather than allowed to double-count.
 * This is contention protection, not distributed locking: the lease is
 * released at the end of the pass (and best-effort on a throw), and a process
 * that DIES mid-pass — a Cloud Run instance killed, a request timing out —
 * leaves the claim standing until it expires, so a resume can be up to
 * `PASS_LEASE_MS` away. That window is the deliberate cost of exact totals.
 *
 * THE DRAINED-GUARD THROWS (the P8 lesson, inherited from
 * `deleteOwnedCourseRows` / `clearCourseAttendanceMarks`): a delete that
 * reports success without removing rows would otherwise loop forever while
 * "making progress" on paper — audit counts inflating over rows that are
 * still there. Two guards, both fatal: a page whose first doc id repeats
 * after a committed delete, and a full-pass ceiling. A throw surfaces as a
 * 500 and leaves the marker + open audit row in place for a retry; a silent
 * stop would report a clean destroy over surviving member data.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Rows per page for the collection drains (accountDeletion uses 300). */
const DESTROY_PAGE_SIZE = 250;

/**
 * Documents one invocation may delete before returning `complete: false`.
 * Sized so a typical run (a few hundred progress rows, tens of everything
 * else) destroys in one or two calls, while a pathological one can never pin
 * a request for minutes.
 */
const DESTROY_DOC_BUDGET = 500;

/**
 * Mirrored tasks page small: each task costs a subcollection sweep
 * (`recursiveDelete`) on top of its own doc, so one page of these is much
 * heavier than one page of leaf rows.
 */
const TASK_PAGE_SIZE = 25;

/**
 * Full-pass ceiling for the drain loop. Every stage drains in pass 1 in the
 * normal case and pass 2 is the empty verify pass; more than a handful of
 * passes means rows are being recreated as fast as they are deleted (or a
 * delete is not taking effect), and the honest response is a throw, not a
 * busy loop — see the module comment's drained-guard paragraph.
 */
const MAX_PASSES = 5;

/**
 * How long one invocation's claim on the audit row lasts (see the module
 * comment's ONE PASS AT A TIME paragraph). Comfortably longer than a pass —
 * Cloud Run caps a request at 60s and the budget is sized well inside that —
 * and short enough that a crashed pass does not strand the resume for long.
 */
const PASS_LEASE_MS = 3 * 60 * 1000;

/**
 * The ONLY `tasks.source` a run's cascade may delete — the value
 * `courseTasks.ts` stamps on a week mirror (`TaskSource`'s
 * "fellowship-reminder"). See drainMirroredTasks for why this is a security
 * filter rather than a tidier query.
 */
const MIRRORED_TASK_SOURCE = "fellowship-reminder";

export const COURSE_DELETIONS_COLLECTION = "courseDeletions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Everything a run destroy touches, counted LIVE at request time. Keys match
 * the pinned `DestroyManifest.counts` contract exactly.
 *
 * `emailSendRows` is counted but NEVER deleted: `emailSends` is the
 * append-only deliverability audit (the same reason accountDeletion leaves
 * it alone), and the manifest UI copy must say so — the number is "how much
 * history mentions this run", not "rows that will die".
 */
export type RunDestroyCounts = {
  weeks: number;
  groups: number;
  applications: number;
  enrolments: number;
  progress: number;
  exerciseResponses: number;
  attendanceRegisters: number;
  /**
   * `courseMaterialNotes` rows — the facilitators' free-text "how did this
   * land" assessments of this run's curriculum (V2-2, v2 decision 3). Keyed
   * `{runId}__{itemId}__{uid}` with `runId` on the row, so they are addressed
   * exactly like every other leaf here.
   *
   * They are STAFF writing, not member work, and they die with the run
   * anyway: the note's subject is a `material.id` inside a week document this
   * cascade is about to delete, so a surviving note describes a curriculum
   * nothing can render and names a cohort nothing can find. Counting them is
   * the point of the manifest line — an admin about to destroy a run should
   * be told that the team's written assessment of it goes too.
   */
  materialNotes: number;
  mirroredTasks: number;
  subscriptionRows: number;
  /**
   * `admissionApplications` whose `outcome.targetRunId` is this run: the
   * people a decider placed HERE.
   *
   * These rows are NOT deleted, and they are not merely orphaned either:
   * they are RELEASED. See `releaseAdmissionSeats` for the argument; the
   * manifest line exists because "eleven people were placed on this cohort
   * and will be released from it" is the single most consequential sentence
   * a destroy dialog can show, and the counter it is built from is the only
   * place it can come from.
   *
   * `admissionRounds` themselves are untouched by any cascade in this file.
   * A round outlives every run it fed (one round feeds several, and an
   * appointment round feeds none), so destroying a run must never reach the
   * round that placed people on it. Destroying a ROUND is a separate
   * protocol with its own typed confirmation and its own manifest, and it is
   * not built yet.
   */
  admissionSeatOffers: number;
  emailSendRows: number;
};

export type CourseDestroyCounts = {
  /** Live runs still attached — every one of them is a blocker. */
  runs: number;
  /**
   * `courseTemplates` snapshots whose provenance names this course. NOT
   * deleted: templates are frozen snapshots (v2 decision 2) and orphaned
   * provenance is fine — the count exists so the admin knows how many
   * snapshots will lose their parent link. (The collection ships in V2-2;
   * until then this counts an empty collection and reads 0.)
   */
  templates: number;
};

export type DestroyActor = {
  actorUid: string;
  /** Display name, never an email — the audit row is PII-light on purpose. */
  actorName: string;
};

export type DestroyCascadeResult = {
  auditId: string;
  /**
   * The ACCUMULATED totals for this destroy — the audit row's own `deleted`
   * map, read back after this invocation's increments landed, NOT just this
   * invocation's page.
   *
   * It has to be the accumulated figure because the client renders it as the
   * running total and a resume can begin in a different tab from the one that
   * started the cascade: that tab knows nothing about earlier passes, so
   * anything less than the server stating the whole total leaves it reporting
   * a fraction of what died. (Reported per-pass, the receipt for a
   * 500-then-250 destroy read "500".)
   */
  deleted: Record<string, number>;
  /** False = page budget exhausted; repeat the SAME call to resume. */
  complete: boolean;
  /** True when this call resumed an interrupted destroy. */
  resumed: boolean;
};

/**
 * The destroy marker as stored on a run / course doc: what `beginDestroy`
 * stamps and what a resume keys off. Read through this rather than poking at
 * raw fields so every surface agrees on what "mid-destroy" means.
 */
export type DestroyMarker = {
  /** A cascade has begun on this document and has not finished. */
  destroying: boolean;
  /** The `courseDeletions` row it accumulates into. Empty when unmarked. */
  auditId: string;
};

/**
 * An earlier destroy of this target that never reached `completedAt`, as the
 * manifest routes report it. This is what turns a crashed cascade from
 * "console archaeology" into a banner with a Resume button.
 */
export type InterruptedDestroyReport = {
  auditId: string;
  /** ISO 8601 — the wire has no Timestamp, and the client re-zones nothing. */
  startedAt: string | null;
  /** Display name, never an email (the audit row is PII-light). */
  startedByName: string | null;
  /** What that attempt had already removed when it stopped. */
  deleted: Record<string, number>;
};

/**
 * Thrown when a destroy is refused outright (blockers present). Routes map
 * it to 409 with the sentences intact. A refusal happens only on a FRESH
 * destroy — a resume never re-evaluates blockers, because the decision was
 * already made and half the data is already gone; re-blocking would wedge an
 * interrupted cascade forever (e.g. a "running" run whose status can no
 * longer be moved because the admin UI dropped it on archive).
 */
export class DestroyBlockedError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(blockers[0] ?? "This destroy is blocked.");
    this.name = "DestroyBlockedError";
    this.blockers = blockers;
  }
}

/**
 * Thrown when another invocation already holds the audit row's pass lease.
 * Routes map it to 409 with the sentence intact. NOT a failure: the destroy
 * is running, and the honest answer to "run another pass" is "one is already
 * running" rather than a second cascade double-counting the same pages into
 * the same audit row.
 */
export class DestroyPassInFlightError extends Error {
  readonly auditId: string;
  /** When the current claim lapses — the earliest a retry can succeed. */
  readonly until: Date;
  constructor(auditId: string, until: Date) {
    super(
      "A destroy pass is already running for this. Wait for it to finish and then resume — starting a second pass now would count the same rows twice.",
    );
    this.name = "DestroyPassInFlightError";
    this.auditId = auditId;
    this.until = until;
  }
}

// ---------------------------------------------------------------------------
// Budget + drain primitives
// ---------------------------------------------------------------------------

type Budget = { remaining: number };

type DrainResult = { deleted: number; drained: boolean };

async function countAgg(query: Query): Promise<number> {
  return (await query.count().get()).data().count;
}

/**
 * Drain one collection query with delete-as-you-read pagination. No cursor:
 * deleting the page makes the next query's first page the next unprocessed
 * page (the `deleteOwnedCourseRows` property that resumability rides on).
 *
 * The first-doc-id guard is the per-stage half of the drained-guard: if a
 * committed batch delete leaves the same doc at the head of the next page,
 * deletes are not taking effect and continuing would burn budget while the
 * audit row inflates over rows that still exist — so it THROWS (P8 lesson).
 */
async function drainQuery(
  db: Firestore,
  label: string,
  buildQuery: () => Query,
  budget: Budget,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(DESTROY_PAGE_SIZE, budget.remaining);
    const snap = await buildQuery().limit(limit).get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        `courseDeletion: ${label} page did not shrink after a committed delete — ` +
          `aborting rather than looping (a silent stop would report progress over rows that are still there)`,
      );
    }
    prevFirstId = firstId;

    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    deleted += snap.size;
    budget.remaining -= snap.size;

    // Fewer rows than asked for = the query has no more matches.
    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/**
 * Drain the run's mirrored My Work tasks: `tasks` where `source ==
 * "fellowship-reminder"` AND `sourceRef.cohortId == runId` — both halves of
 * what courseTasks.ts stamps on a mirror, not just the pointer.
 *
 * THE `source` HALF IS A SECURITY FILTER, not a tidy-up. `sourceRef` is
 * writable-ish from the client in a way `source` is not: rules pin `source`
 * against rewriting but `sourceRef` is only kept out of the completer's narrow
 * band, so on the committee lane a committee member could stamp
 * `sourceRef.cohortId` onto an ordinary committee task. Aimed at a run that is
 * about to be destroyed, that hands them the admin's cascade: a
 * `recursiveDelete` of somebody else's task with its comments, its activity
 * log, its attachments and their Storage blobs. Filtering on the source the
 * mirror ACTUALLY carries means a forged pointer names nothing this drain will
 * touch. (firestore.rules pins `sourceRef` too, as of the same change — this
 * is the belt to that brace, and it is the half that holds for rows written
 * before the pin.)
 *
 * INDEX NOTE: two equality filters, one of them on a map subfield. Both are
 * served by AUTOMATIC single-field indexes (map subfields are auto-indexed
 * like top-level fields) and Firestore merges them — the same index-merging
 * this file already relies on for the (runId, status) enrolment count — so no
 * composite index is needed and none was added to firestore.indexes.json.
 *
 * DELIBERATE CONTRAST with accountDeletion, which RETAINS mirrored tasks on
 * an account delete: there the member lives on and the mirror is their
 * content, owned by the deferred tasks hygiene sweep. Here the RUN is dying
 * — the mirror's referent evaporates, its title/description ARE the run's
 * curriculum, and leaving per-member copies of a destroyed run's content
 * behind would defeat the destroy. Destroying member work like this is
 * exactly why the destroy routes are admin-only rather than approveCourse.
 *
 * A parent-doc delete does NOT delete subcollections, and mirrors can carry
 * member comments/activity/attachments (they behave like personal tasks), so
 * each task goes through `db.recursiveDelete` — the same BulkWriter-backed
 * path the tasks delete route uses — with the attachment Storage paths
 * enumerated FIRST (after the doc is gone nothing names the blobs). Storage
 * cleanup is best-effort, mirroring that route: an orphaned blob is strictly
 * better than a phantom doc, and a Storage blip must not wedge the cascade.
 *
 * Budget is charged one per TASK, not per subcollection row — the manifest
 * counts tasks, and sub-rows on a mirror are typically zero-to-few.
 */
async function drainMirroredTasks(
  db: Firestore,
  storage: Storage | null,
  runId: string,
  budget: Budget,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(TASK_PAGE_SIZE, budget.remaining);
    const snap = await db
      .collection("tasks")
      .where("source", "==", MIRRORED_TASK_SOURCE)
      .where("sourceRef.cohortId", "==", runId)
      .limit(limit)
      .get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        "courseDeletion: mirrored-tasks page did not shrink after recursiveDelete — aborting rather than looping",
      );
    }
    prevFirstId = firstId;

    for (const doc of snap.docs) {
      // Storage paths BEFORE the recursive delete — afterwards nothing names
      // them. A failed enumeration strands blobs, not docs: log and carry on.
      let storagePaths: string[] = [];
      try {
        const att = await doc.ref.collection("attachments").get();
        storagePaths = ownedStoragePaths(
          doc.id,
          att.docs.map((d) => d.data().storagePath),
        );
      } catch (err) {
        console.error(
          "[courseDeletion] attachment enumeration failed (blobs may be orphaned):",
          doc.id,
          err,
        );
      }

      await db.recursiveDelete(doc.ref);
      deleted += 1;
      budget.remaining -= 1;

      if (storage && storagePaths.length > 0) {
        const bucket = storage.bucket();
        await Promise.all(
          storagePaths.map(async (path) => {
            try {
              await bucket.file(path).delete({ ignoreNotFound: true });
            } catch (err) {
              console.warn(
                `[courseDeletion] storage delete failed for ${path} (best-effort):`,
                err,
              );
            }
          }),
        );
      }
    }

    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/**
 * Drain the cohort channel's subscription rows — the unsubscribe-style
 * removal: the ROW is what makes an address a recipient
 * (`findRecipientsForChannel` filters on it), so deleting rows is what stops
 * cohort mail; there is no per-row flag worth preserving on a channel that
 * is about to have no run behind it.
 *
 * THE CHANNEL IS COMPUTED, NEVER READ OFF THE RUN. Callers pass
 * `courseRunChannel(runId)`; the stored `courseRuns.channel` field is not
 * consulted anywhere in this module. A run doc carrying `channel:
 * "newsletter"` — a console edit, a bad migration, an admin who is outside
 * the rules pin on that field — would otherwise turn one run's destroy into a
 * mass-unsubscribe of the site's whole newsletter list, with the rows gone
 * before anyone read the manifest. Computing it makes that unreachable
 * instead of merely unlikely, and costs nothing: every other consumer of the
 * cohort channel (the send route, the allocation publish, the nudge route,
 * the unsubscribe link) already derives it the same way, so nothing legitimate
 * depends on the stored value.
 *
 * Each page's event-log lines go with their rows (`subscriptionEvents` lives
 * exactly as long as the row it describes — the GDPR-clean rule in
 * subscriptions.ts). Rows first, events best-effort, same as
 * accountDeletion's step 1/1b: once the rows (the mailing source) are gone a
 * stale audit line is acceptable degradation, and it must not abort the
 * cascade — but it IS unrecoverable (the ids that named the events went with
 * the rows), so it is logged loudly. Events are recorded in `extraTotals`
 * and not charged against the budget: they are bounded by their own rows (a
 * handful per subscription).
 */
async function drainSubscriptionRows(
  db: Firestore,
  channel: string,
  budget: Budget,
  extraTotals: Record<string, number>,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(DESTROY_PAGE_SIZE, budget.remaining);
    const snap = await db
      .collection("subscriptions")
      .where("channel", "==", channel)
      .limit(limit)
      .get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        "courseDeletion: subscription page did not shrink after a committed delete — aborting rather than looping",
      );
    }
    prevFirstId = firstId;

    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    deleted += snap.size;
    budget.remaining -= snap.size;

    try {
      const events = await deleteEventsForSubscriptions(
        db,
        snap.docs.map((d) => d.id),
      );
      extraTotals.subscriptionEvents =
        (extraTotals.subscriptionEvents ?? 0) + events;
    } catch (err) {
      console.error(
        "[courseDeletion] subscriptionEvents cleanup failed (best-effort, now unrecoverable — the row ids are gone):",
        channel,
        err,
      );
    }

    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/**
 * RELEASE, not delete: the admission applications whose outcome placed
 * somebody on this run.
 *
 * ## Why these rows survive a destroy
 *
 * An `admissionApplications` row is a PERSON'S APPLICATION. It belongs to the
 * round and to the applicant, not to the run: it holds the essays they wrote,
 * their availability, their evidence snapshot and the decision that was made
 * about them, and the owner's decision is that applications are kept and
 * stored against the account. One round also feeds several runs, so deleting
 * every application pointing at one destroyed run would take rows belonging
 * to an intake that is still live and still being decided.
 *
 * ## Why they cannot be left untouched either
 *
 * The seat those rows describe is being destroyed. Leaving them says three
 * false things at once: `status: "accepted"` claims a place on a cohort that
 * no longer exists, `outcome.targetRunId` points at a document nothing can
 * resolve, and `seatApplicationId` names a `courseApplications` row this same
 * cascade has already deleted. The status hub would show a live placement on
 * a cohort nothing can open.
 *
 * So each row is RELEASED: `status` becomes `withdrawn`, and the two
 * pointers are cleared. What actually happened is still legible from the row
 * (the decision, the decider, the timestamp and the reason are all
 * untouched) and from the destroy audit row, which records how many were
 * released. Withdrawn is the right terminal status because it is the one the
 * decide route already treats as "holds no seat": reinstating somebody is
 * `withdrawn -> submitted` inside the counter transaction, so a released
 * applicant can be put back into a live round by the route that already
 * exists, rather than needing a repair nobody has written.
 *
 * `withdrawnAt` is deliberately NOT stamped. It records when THE APPLICANT
 * withdrew, and reading it is how the reapply flow and the queue tell a
 * person's own change of mind from anything else; a system release is not
 * that, and back-dating one would put an act on the applicant's record that
 * they never performed. The destroy audit row carries the when, the who and
 * the how many for this release, and `updatedAt` moves, so nothing is lost.
 *
 * ## The round's counters are deliberately NOT moved here
 *
 * A release does not touch `admissionRounds.applicationCounts`, and nothing
 * anywhere in this file writes an `admissionRounds` document (a test pins
 * that). The counters are relative increments owned by the apply, submit and
 * decide transactions; a second writer outside those transactions is how a
 * counter goes wrong, not how it is repaired. And a round outlives every run
 * it fed, so a run destroy must never reach one.
 *
 * The consequence is real and accepted: after a destroy, a round's accepted
 * count can read higher than its rows justify. The repair is the round's own
 * recount, `POST /api/admissions/rounds/[roundId]/recount` (PR33), which
 * rebuilds the numbers from the rows themselves. It is the same repair the
 * account cascade leans on for the same reason.
 *
 * ## Why clearing `outcome.targetRunId` is load-bearing, not tidiness
 *
 * It is also what makes this stage drain. Every other stage here is
 * delete-as-you-read: the page it processes stops matching the query, so the
 * next query's first page IS the next unprocessed page, and the
 * first-doc-id guard can tell "nothing is happening" from "still working".
 * An update that left the row matching would re-read the same page forever
 * and trip that guard on the first pass. Clearing the pointer gives an update
 * the same property a delete has, and it is the honest write regardless: a
 * pointer at a destroyed run is not information.
 */
async function releaseAdmissionSeats(
  db: Firestore,
  runId: string,
  budget: Budget,
): Promise<DrainResult> {
  let released = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(DESTROY_PAGE_SIZE, budget.remaining);
    const snap = await db
      .collection("admissionApplications")
      .where("outcome.targetRunId", "==", runId)
      .limit(limit)
      .get();
    if (snap.empty) return { deleted: released, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        "courseDeletion: admissionApplications page did not shrink after a committed release, " +
          "aborting rather than looping (a silent stop would report progress over rows still holding a seat)",
      );
    }
    prevFirstId = firstId;

    const batch = db.batch();
    for (const d of snap.docs) {
      // The dotted key IS a field path here, and that is what is wanted:
      // `outcome` is a map and only its `targetRunId` leaf moves, so the
      // decision, the decider and the reason all survive untouched.
      //
      // `update` on a document deleted between the read and the commit aborts
      // the whole batch. The only thing that deletes an admission application
      // is an account cascade, so the race is a member deleting their account
      // mid-destroy: the batch fails, this stage throws, and the destroy stops
      // with its audit row open for a resume that will simply not see the row.
      // That is the same failure shape the delete stages have, and the same
      // recovery.
      batch.update(d.ref, {
        status: "withdrawn",
        seatApplicationId: null,
        "outcome.targetRunId": null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    released += snap.size;
    budget.remaining -= snap.size;

    if (snap.size < limit) return { deleted: released, drained: true };
  }
  return { deleted: released, drained: false };
}

// ---------------------------------------------------------------------------
// Manifest counts + blockers (run)
// ---------------------------------------------------------------------------

/**
 * Live counts of everything a run destroy would touch — aggregate count
 * queries at request time, so the confirmation dialog shows what dies NOW,
 * not what a stale snapshot said. All are single-equality (or equality-pair)
 * filters served by automatic single-field indexes / index merging — no
 * composite indexes were needed.
 */
export async function countRunDestroyTargets(
  db: Firestore,
  run: CourseRunDoc,
): Promise<RunDestroyCounts> {
  const runId = run.id;

  // Group ids feed the emailSends count: group-lane facilitator sends log
  // `referenceId: groupId` while run-lane sends log `referenceId: runId`
  // (courseFacilitatorEmails.ts), so an honest "history mentions this run"
  // number needs both. Chunked `in` filters at Firestore's 30-value cap.
  const groupIdSnap = await db
    .collection("courseGroups")
    .where("runId", "==", runId)
    .select()
    .get();
  const groupIds = groupIdSnap.docs.map((d) => d.id);

  const emailRefIds = [runId, ...groupIds];
  const emailCountPromises: Array<Promise<number>> = [];
  for (let i = 0; i < emailRefIds.length; i += 30) {
    emailCountPromises.push(
      countAgg(
        db
          .collection("emailSends")
          .where("referenceId", "in", emailRefIds.slice(i, i + 30)),
      ),
    );
  }

  const [
    weeks,
    applications,
    enrolments,
    progress,
    exerciseResponses,
    attendanceRegisters,
    materialNotes,
    mirroredTasks,
    subscriptionRows,
    admissionSeatOffers,
    emailSendCounts,
  ] = await Promise.all([
    countAgg(db.collection("courseRuns").doc(runId).collection("weeks")),
    countAgg(db.collection("courseApplications").where("runId", "==", runId)),
    countAgg(db.collection("courseEnrolments").where("runId", "==", runId)),
    countAgg(db.collection("courseProgress").where("runId", "==", runId)),
    countAgg(db.collection("courseExerciseResponses").where("runId", "==", runId)),
    countAgg(db.collection("courseAttendance").where("runId", "==", runId)),
    // The note rows carry `runId` as a FIELD as well as inside their doc id
    // (the id is construct-only, never parsed — see courseMaterialNotes.ts),
    // so this is the same single-equality shape as every other leaf above and
    // is served by the automatic single-field index.
    countAgg(
      db.collection(COURSE_MATERIAL_NOTES_COLLECTION).where("runId", "==", runId),
    ),
    // Both halves of the mirror predicate, exactly as drainMirroredTasks
    // deletes them — a manifest that counted forged pointers would promise to
    // destroy rows the cascade (rightly) leaves alone.
    countAgg(
      db
        .collection("tasks")
        .where("source", "==", MIRRORED_TASK_SOURCE)
        .where("sourceRef.cohortId", "==", runId),
    ),
    // The COMPUTED channel, never `run.channel` — see drainSubscriptionRows.
    countAgg(
      db.collection("subscriptions").where("channel", "==", courseRunChannel(runId)),
    ),
    // Single equality on a nested field, served by the automatic single-field
    // index like every other leaf here. It counts the rows the cascade will
    // RELEASE, which is the same predicate `releaseAdmissionSeats` drains
    // on. A manifest built on a different filter would promise to touch rows
    // the cascade leaves alone, or hide ones it does not.
    countAgg(
      db.collection("admissionApplications").where("outcome.targetRunId", "==", runId),
    ),
    Promise.all(emailCountPromises),
  ]);

  return {
    weeks,
    groups: groupIds.length,
    applications,
    enrolments,
    progress,
    exerciseResponses,
    attendanceRegisters,
    materialNotes,
    mirroredTasks,
    subscriptionRows,
    admissionSeatOffers,
    emailSendRows: emailSendCounts.reduce((a, b) => a + b, 0),
  };
}

/**
 * The refuse-outright conditions. Human sentences, because they are shown
 * verbatim in the Danger zone dialog: each names the state AND the path out —
 * destroy is never the first tool.
 *
 * The path out has to be one that WORKS. The running-cohort sentence used to
 * say "archive it first", which is a dead end: `archived` is orthogonal to
 * `status` (the v2 decision), so archiving leaves the run `running` and the
 * identical blocker comes straight back. The gate stays where it is — an
 * archived-but-running cohort with live members is not something to make
 * destroyable in one step — and the sentence now names the two exits that
 * actually clear it: move the run to a settled status, or remove the members.
 */
export async function runDestroyBlockers(
  db: Firestore,
  run: CourseRunDoc,
  now: Date = new Date(),
): Promise<string[]> {
  const blockers: string[] = [];

  if (run.status === "running") {
    // Equality + equality is served by index merging — no composite needed.
    const active = await countAgg(
      db
        .collection("courseEnrolments")
        .where("runId", "==", run.id)
        .where("status", "==", "active"),
    );
    if (active > 0) {
      blockers.push(
        `This run is running with ${active} active enrolment${active === 1 ? "" : "s"} — mark the run completed or cancelled, or remove its active members, before destroying it.`,
      );
    }
  }

  // "Currently open" mirrors the apply route's gate exactly (status AND
  // window): a run whose close date has passed is not accepting applications
  // even if nobody moved the status, and must not be blocked on a technicality.
  const opened =
    !run.applicationsOpenAt || now.getTime() >= run.applicationsOpenAt.getTime();
  const notClosed =
    !run.applicationsCloseAt || now.getTime() <= run.applicationsCloseAt.getTime();
  if (run.status === "applications-open" && opened && notClosed) {
    blockers.push(
      "Applications for this run are currently open — close applications before destroying it.",
    );
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// The destroy marker + the interrupted report
// ---------------------------------------------------------------------------

/**
 * The marker as stored on a run / course doc. One reader, so "is this thing
 * mid-destroy?" is answered the same way by the cascades, the manifests, the
 * archive/status routes and the learning-space gate. A marker needs BOTH
 * halves: `destroying` without an audit id names no row to resume into.
 */
export function readDestroyMarker(raw: Record<string, unknown> | undefined): DestroyMarker {
  const auditId = typeof raw?.destroyAuditId === "string" ? raw.destroyAuditId : "";
  return { destroying: raw?.destroying === true && auditId.length > 0, auditId };
}

/** Non-negative integers only, from an audit row's `deleted` map. */
function auditDeletedTotals(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = Math.floor(value);
    }
  }
  return out;
}

/**
 * What an interrupted destroy of this target looks like from outside, or null
 * when there isn't one.
 *
 * TWO documents, no query: the marker on the target NAMES its audit row, so
 * this is a single `get()` (no `completedAt == null` index, no ordering) — it
 * is cheap enough to run on every visit to the editor, which is the point.
 * A marker whose audit row has been hand-deleted still reports interrupted
 * with empty totals: the marker itself is the evidence that a cascade began,
 * and `beginDestroy` will recreate the row under the same id on resume.
 */
export async function readInterruptedDestroy(
  db: Firestore,
  targetRaw: Record<string, unknown> | undefined,
): Promise<InterruptedDestroyReport | null> {
  const marker = readDestroyMarker(targetRaw);
  if (!marker.destroying) return null;

  const snap = await db
    .collection(COURSE_DELETIONS_COLLECTION)
    .doc(marker.auditId)
    .get();
  if (!snap.exists) {
    return { auditId: marker.auditId, startedAt: null, startedByName: null, deleted: {} };
  }
  const raw = snap.data() ?? {};
  // A completed row over a target that still exists is not an interruption —
  // the finalising batch deletes the target and stamps completedAt together,
  // so this can only be a hand-edited row. Nothing to resume, so say nothing.
  if (raw.completedAt) return null;

  const startedAt = raw.startedAt as { toDate?: () => Date } | undefined;
  return {
    auditId: marker.auditId,
    startedAt:
      typeof startedAt?.toDate === "function" ? startedAt.toDate().toISOString() : null,
    startedByName:
      typeof raw.startedByName === "string" && raw.startedByName ? raw.startedByName : null,
    deleted: auditDeletedTotals(raw.deleted),
  };
}

// ---------------------------------------------------------------------------
// The run cascade
// ---------------------------------------------------------------------------

/**
 * Begin (or resume) a destroy: one TRANSACTION that either finds the marker
 * a previous invocation left, or creates the audit row and stamps the marker
 * in the same atomic write. The same transaction CLAIMS the row for this pass
 * (`passInFlightUntil`), which is what stops two overlapping invocations
 * incrementing the same counters over the same pages — see the module
 * comment's ONE PASS AT A TIME paragraph.
 *
 * Why a transaction and not a batch: two admins double-clicking Destroy race
 * to this point, and a batch pair would let both create an audit row — one
 * of them dangling with `completedAt: null` forever, indistinguishable from
 * a real interrupted destroy. The transaction re-reads the marker so exactly
 * one caller creates the audit row and the loser resumes it.
 *
 * The marker write is the "unreachable the moment destroy starts" guarantee:
 * `archived: true` (drops the run from every discovery surface) plus
 * `destroying: true` and `destroyAuditId` (what resume keys off), in the
 * SAME write as the audit-row create — there is no instant where deletion
 * has begun but no audit row exists, and none where an audit row exists but
 * the run still looks alive.
 */
async function beginDestroy(
  db: Firestore,
  targetRef: DocumentReference,
  markerPatch: Record<string, unknown>,
  auditSeed: Record<string, unknown>,
): Promise<{ auditRef: DocumentReference; resumed: boolean }> {
  const leaseUntil = Timestamp.fromMillis(Date.now() + PASS_LEASE_MS);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(targetRef);
    if (!snap.exists) {
      throw new Error(`courseDeletion: ${targetRef.path} vanished before destroy began`);
    }
    const raw = snap.data() ?? {};
    const marker = readDestroyMarker(raw);

    if (marker.destroying) {
      const auditRef = db.collection(COURSE_DELETIONS_COLLECTION).doc(marker.auditId);
      const auditSnap = await txn.get(auditRef);
      if (auditSnap.exists) {
        assertPassLeaseFree(auditSnap.data() ?? {}, marker.auditId);
        txn.update(auditRef, {
          resumeCount: FieldValue.increment(1),
          passInFlightUntil: leaseUntil,
        });
        return { auditRef, resumed: true };
      }
      // A dangling marker (audit row hand-deleted in the console) must not
      // wedge the destroy forever: recreate the audit row under the SAME id
      // so the marker stays truthful, and say so in the log.
      console.error(
        "[courseDeletion] marker names a missing audit row — recreating it:",
        targetRef.path,
        marker.auditId,
      );
      txn.set(auditRef, { ...auditSeed, resumeCount: 1, passInFlightUntil: leaseUntil });
      return { auditRef, resumed: true };
    }

    const auditRef = db.collection(COURSE_DELETIONS_COLLECTION).doc();
    // A FRESH row needs no lease check — it is being created here, so nobody
    // else can be holding it. (Two admins racing this transaction is the
    // Firestore contention case the comment above describes: the loser
    // re-runs, sees the marker, and takes the resume branch — where the lease
    // it now finds is what refuses it.)
    txn.create(auditRef, { ...auditSeed, resumeCount: 0, passInFlightUntil: leaseUntil });
    txn.update(targetRef, {
      ...markerPatch,
      destroying: true,
      destroyAuditId: auditRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { auditRef, resumed: false };
  });
}

/** Refuse this pass if another invocation's claim on the row is still live. */
function assertPassLeaseFree(auditRaw: Record<string, unknown>, auditId: string): void {
  const lease = auditRaw.passInFlightUntil as { toMillis?: () => number } | null | undefined;
  const until = typeof lease?.toMillis === "function" ? lease.toMillis() : 0;
  if (until > Date.now()) throw new DestroyPassInFlightError(auditId, new Date(until));
}

/**
 * Hand the audit row's claim back. Called on the way out of every pass —
 * including the finalising batch, which sets it alongside `completedAt`.
 */
const PASS_LEASE_RELEASED = { passInFlightUntil: null } as const;

/**
 * The audit row's ACCUMULATED `deleted` map, read back after this pass's
 * increments have landed. This is what the cascade returns (see
 * DestroyCascadeResult.deleted).
 *
 * A failed read-back falls back to this pass's own counts rather than
 * throwing: by the time it runs, the deletions are done and — on the
 * completing pass — the target document is already gone, so throwing here
 * would report a failure for a destroy that finished and send the client into
 * a resume that can no longer find its target.
 */
async function readAuditTotals(
  auditRef: DocumentReference,
  fallback: Record<string, number>,
): Promise<Record<string, number>> {
  try {
    const snap = await auditRef.get();
    return auditDeletedTotals((snap.data() ?? {}).deleted);
  } catch (err) {
    console.error(
      "[courseDeletion] could not read back the audit totals — reporting this pass's own counts:",
      auditRef.id,
      err,
    );
    return fallback;
  }
}

/** Accumulate this invocation's per-collection counts into the audit row. */
function auditIncrements(totals: Record<string, number>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, n] of Object.entries(totals)) {
    // Keys are our fixed stage identifiers (never user data), so the dotted
    // path is a deliberate nested-map update, not the attendance map-key
    // hazard accountDeletion guards with FieldPath.
    if (n > 0) patch[`deleted.${key}`] = FieldValue.increment(n);
  }
  return patch;
}

/**
 * Destroy one course run. Admin-only (enforced at the route, restated here:
 * destroying member work — progress, answers, attendance — is ABOVE the
 * approveCourse content permission by locked decision). Resumable; see the
 * module comment for the contract.
 *
 * ORDER OF OPERATIONS — each step says why it sits where it does:
 *
 *  0. Blockers re-checked (fresh destroys only — see DestroyBlockedError),
 *     THEN the audit row + marker transaction. Audit first is crash-safety:
 *     from this point on, an open audit row exists for anything that dies.
 *  1. Leaf rows the run owns — progress, exercise responses, attendance,
 *     facilitator material notes — BEFORE the enrolments. This is the
 *     accountDeletion lesson (its attendance sweep runs before the enrolment
 *     delete because the enrolments are what name the runs to scan) carried
 *     over: keep the rows that gate or name a step alive until the step is
 *     done. Here every leaf carries `runId` directly, so the dependency is
 *     not addressability but the WRITE GATE: firestore.rules'
 *     `isEnrolledActive()` lets a member client-write courseProgress until
 *     their enrolment dies, so a member racing the sweep can re-create a row
 *     AFTER its stage drained. That is also why attendance is whole-DOC
 *     deletion here, unlike account deletion's per-uid map-key surgery: there
 *     the register outlived one member; here the register itself is dying
 *     with its run. `courseMaterialNotes` has no such gate (rules deny every
 *     client write to it) and joins the leaves for consistency, not
 *     necessity — but it MUST be drained by something: the notes are staff
 *     assessments of week content this cascade deletes, so left behind they
 *     describe a curriculum nothing can render, for a cohort nothing can
 *     find.
 *  2. Enrolments — immediately after the leaves, which SHUTS the member
 *     write gate (and the enrolment-gated routes: exercises, sync-tasks).
 *     No group memberCount decrement, deliberately — accountDeletion
 *     decrements because its groups SURVIVE the member; here the groups die
 *     below in this same cascade, and a doomed doc's counter is dead bytes.
 *  3. Applications (email PII + denormalised names — same reasoning as
 *     accountDeletion's SCOPE note: with the run gone these render as ghost
 *     rows no surface can find).
 *  4. Mirrored My Work tasks (see drainMirroredTasks — the deliberate
 *     inversion of accountDeletion's retain-tasks rule, and the index note).
 *  5. Nudge markers (courseNudges) — send-dedupe machinery keyed by runId;
 *     hygiene, so counted in `deleted` but not in the manifest.
 *  6. Subscription rows on the cohort channel + their event log (see
 *     drainSubscriptionRows). After this, nothing can mail the cohort.
 *  7. Groups, then weeks — the structural containers, after everything that
 *     referenced them.
 *  8. The run doc LAST, in the SAME batch as the audit row's `completedAt`
 *     stamp and the parent course's `showcaseRunId` clear (a public course
 *     page must not point its shop window at a destroyed run). While the run
 *     doc exists a resumed cascade can still find everything; deleting it is
 *     the one write that makes the destroy final, so it travels atomically
 *     with the record that says the destroy finished.
 *
 * `emailSends` rows are counted in the manifest but NEVER deleted — they are
 * the append-only deliverability audit, and a destroy erases the run's data,
 * not the record of what NAISI sent people.
 *
 * The drain loop runs FULL PASSES until a pass deletes nothing: pass 1 does
 * the work, and the mandatory zero-delete pass is the verification that
 * closes the leaf-recreation race in step 1 — by the time a pass finds every
 * collection empty, the enrolments (write gate) have been gone since an
 * earlier pass, so nothing can have slipped in behind it.
 */
export async function destroyRunCascade(
  db: Firestore,
  storage: Storage | null,
  runId: string,
  actor: DestroyActor,
): Promise<DestroyCascadeResult> {
  const runRef = db.collection("courseRuns").doc(runId);
  const preSnap = await runRef.get();
  if (!preSnap.exists) {
    throw new Error(`courseDeletion: run ${runId} not found`);
  }
  const preRaw = preSnap.data() ?? {};
  const run = normalizeCourseRun(preSnap.id, preRaw);
  const alreadyDestroying = readDestroyMarker(preRaw).destroying;

  // Blockers gate FRESH destroys only (see DestroyBlockedError for why a
  // resume must never re-block). TOCTOU between this check and the marker
  // transaction is accepted: both ends are admin actions, and the marker
  // write itself freezes the surfaces that could change the answer.
  if (!alreadyDestroying) {
    const blockers = await runDestroyBlockers(db, run);
    if (blockers.length > 0) throw new DestroyBlockedError(blockers);
  }

  // Manifest counts are stamped onto the audit row at destroy time — the
  // permanent record of what the admin was told was about to die. Computed
  // before the transaction (aggregate queries don't belong inside it); on a
  // resume they are only used if the audit row needs recreating.
  const manifestCounts = await countRunDestroyTargets(db, run);

  const { auditRef, resumed } = await beginDestroy(
    db,
    runRef,
    { archived: true },
    {
      kind: "run",
      targetId: runId,
      targetLabel: run.label,
      startedAt: FieldValue.serverTimestamp(),
      startedByUid: actor.actorUid,
      startedByName: actor.actorName,
      manifestCounts,
      deleted: {},
      completedAt: null,
    },
  );

  // ---- The drain ----------------------------------------------------------

  const budget: Budget = { remaining: DESTROY_DOC_BUDGET };
  const totals: Record<string, number> = {};
  const byRunId = (collection: string) => () =>
    db.collection(collection).where("runId", "==", runId);

  const stages: Array<{ key: string; drain: () => Promise<DrainResult> }> = [
    // NOTE for anyone adding one: the table below is read by
    // tests/course-deletion.test.mjs as the cascade's declared stage ORDER, so
    // keep it a literal and keep every entry's `key` a string literal.
    {
      key: "progress",
      drain: () => drainQuery(db, "courseProgress", byRunId("courseProgress"), budget),
    },
    {
      key: "exerciseResponses",
      drain: () =>
        drainQuery(db, "courseExerciseResponses", byRunId("courseExerciseResponses"), budget),
    },
    {
      key: "attendanceRegisters",
      drain: () => drainQuery(db, "courseAttendance", byRunId("courseAttendance"), budget),
    },
    {
      key: "materialNotes",
      // A leaf like the three above it — one `runId` equality, whole-document
      // deletion — so it drains here with them rather than after the
      // enrolments. Nothing gates these writes the way `isEnrolledActive()`
      // gates courseProgress (rules deny every client write to the
      // collection; only the material-notes route writes it, and that route
      // refuses a run carrying the destroy marker), so ordering it with the
      // leaves is consistency rather than necessity — and consistency is what
      // stops the next reader having to work out which rule this one follows.
      drain: () =>
        drainQuery(
          db,
          COURSE_MATERIAL_NOTES_COLLECTION,
          byRunId(COURSE_MATERIAL_NOTES_COLLECTION),
          budget,
        ),
    },
    {
      key: "enrolments",
      drain: () => drainQuery(db, "courseEnrolments", byRunId("courseEnrolments"), budget),
    },
    {
      key: "applications",
      drain: () =>
        drainQuery(db, "courseApplications", byRunId("courseApplications"), budget),
    },
    {
      key: "admissionSeatOffers",
      // The ONE stage that does not delete anything: it releases the
      // admission applications that placed people here (see
      // releaseAdmissionSeats). It runs immediately after the seat rows it
      // points at, because until those are gone `seatApplicationId` still
      // names something real, and clearing it first would leave the seat row
      // orphaned in the window between the two.
      drain: () => releaseAdmissionSeats(db, runId, budget),
    },
    {
      key: "mirroredTasks",
      drain: () => drainMirroredTasks(db, storage, runId, budget),
    },
    {
      key: "nudgeMarkers",
      drain: () => drainQuery(db, "courseNudges", byRunId("courseNudges"), budget),
    },
    {
      key: "subscriptionRows",
      // COMPUTED from the run id, never `run.channel` — a doc carrying a
      // channel someone else owns would otherwise aim this drain at their
      // subscriber list. See drainSubscriptionRows.
      drain: () => drainSubscriptionRows(db, courseRunChannel(runId), budget, totals),
    },
    {
      key: "groups",
      drain: () => drainQuery(db, "courseGroups", byRunId("courseGroups"), budget),
    },
    {
      key: "weeks",
      drain: () =>
        drainQuery(db, "weeks", () => runRef.collection("weeks"), budget),
    },
  ];

  // Everything from here to the return holds this pass's lease on the audit
  // row, so every exit — including a throw out of a drain — has to hand it
  // back or the resume waits out the TTL for nothing.
  try {
    let complete = false;
    for (let pass = 1; ; pass += 1) {
      if (pass > MAX_PASSES) {
        // The full-pass half of the drained-guard: rows being recreated as
        // fast as they die (or deletes not landing) must throw, not spin —
        // the open audit row + marker survive for the retry.
        throw new Error(
          `courseDeletion: run ${runId} still producing rows after ${MAX_PASSES} full passes — aborting`,
        );
      }
      let passDeleted = 0;
      let allDrained = true;
      for (const stage of stages) {
        if (budget.remaining <= 0) {
          allDrained = false;
          break;
        }
        const res = await stage.drain();
        totals[stage.key] = (totals[stage.key] ?? 0) + res.deleted;
        passDeleted += res.deleted;
        if (!res.drained) allDrained = false;
      }
      // A stage only reports un-drained when the budget ran out (pathological
      // non-progress throws inside the drain), so !allDrained = out of budget.
      if (!allDrained) break;
      if (passDeleted === 0) {
        complete = true;
        break;
      }
      // Drained with deletions: run the verify pass (see the ORDER comment).
    }

    // ---- Accumulate + (maybe) finalise ------------------------------------

    if (!complete) {
      // Budget spent. Accumulate this invocation's work and release the lease;
      // the marker on the still-live run doc is what lets the repeated call
      // resume, and the audit row is now the running total this returns.
      await auditRef.update({ ...auditIncrements(totals), ...PASS_LEASE_RELEASED });
      return {
        auditId: auditRef.id,
        deleted: await readAuditTotals(auditRef, totals),
        complete: false,
        resumed,
      };
    }

    // Everything drained and verified empty. Finalise ATOMICALLY: the audit
    // row's completedAt, the parent course's showcase clear, and the run doc
    // delete land together — there is no state where the run is gone but the
    // audit row still reads "interrupted", or vice versa.
    const finalBatch = db.batch();
    totals.run = 1;
    finalBatch.update(auditRef, {
      ...auditIncrements(totals),
      ...PASS_LEASE_RELEASED,
      completedAt: FieldValue.serverTimestamp(),
    });
    if (run.courseId) {
      const courseRef = db.collection("courses").doc(run.courseId);
      const courseSnap = await courseRef.get();
      // Only patch a course that exists and actually points here — a
      // batch.update on a missing doc rejects the WHOLE batch (the
      // accountDeletion absent-groups lesson).
      if (courseSnap.exists && (courseSnap.data() ?? {}).showcaseRunId === runId) {
        finalBatch.update(courseRef, {
          showcaseRunId: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    finalBatch.delete(runRef);
    await finalBatch.commit();

    return {
      auditId: auditRef.id,
      deleted: await readAuditTotals(auditRef, totals),
      complete: true,
      resumed,
    };
  } catch (err) {
    // Best-effort: a failed release is not worth masking the real error with,
    // and the TTL collects it. A process that dies outright never reaches
    // here at all — that is the crash window the module comment documents.
    await auditRef.update(PASS_LEASE_RELEASED).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The course cascade
// ---------------------------------------------------------------------------

/** Live counts for the course-level manifest. */
export async function countCourseDestroyTargets(
  db: Firestore,
  course: CourseDoc,
): Promise<CourseDestroyCounts> {
  const [runs, templates] = await Promise.all([
    countAgg(db.collection("courseRuns").where("courseId", "==", course.id)),
    // Ships in V2-2; counting the empty collection reads 0 until then.
    countAgg(db.collection("courseTemplates").where("courseId", "==", course.id)),
  ]);
  return { runs, templates };
}

/**
 * A course refuses to destroy while ANY run exists — runs are destroyed one
 * at a time, deliberately: each run's manifest names ITS dead, and a course
 * destroy that swallowed runs would collapse ten typed confirmations into
 * one. Each surviving run is its own blocker sentence so the admin sees the
 * full path out, not a count to go spelunking for.
 *
 * With zero runs the course should own nothing else — but a stray
 * `courseId`-keyed row (a bug's orphan) would become permanently unfindable
 * once the course doc goes, so strays block too rather than being silently
 * stranded.
 */
export async function courseDestroyBlockers(
  db: Firestore,
  course: CourseDoc,
): Promise<string[]> {
  const blockers: string[] = [];

  const runSnap = await db
    .collection("courseRuns")
    .where("courseId", "==", course.id)
    .limit(25)
    .get();
  for (const doc of runSnap.docs) {
    const run = normalizeCourseRun(doc.id, doc.data() ?? {});
    blockers.push(
      `Run "${run.label || run.id}" still exists — destroy runs one at a time first.`,
    );
  }

  if (runSnap.empty) {
    const [strayGroups, strayEnrolments] = await Promise.all([
      db.collection("courseGroups").where("courseId", "==", course.id).limit(1).get(),
      db.collection("courseEnrolments").where("courseId", "==", course.id).limit(1).get(),
    ]);
    if (!strayGroups.empty) {
      blockers.push(
        "Orphaned group rows still reference this course — investigate before destroying it.",
      );
    }
    if (!strayEnrolments.empty) {
      blockers.push(
        "Orphaned enrolment rows still reference this course — investigate before destroying it.",
      );
    }
  }

  return blockers;
}

/**
 * Destroy a course. By the time this is reachable every run is gone (the
 * blockers above), so the cascade is small: the audit row + marker
 * transaction (`status: "archived"` — the course status union HAS an
 * archived member, unlike runs — plus the destroying marker), a final
 * re-check that no run appeared in the race window, then one atomic batch:
 * audit `completedAt` + course doc delete.
 *
 * Template provenance is deliberately left orphaned: templates are frozen
 * snapshots (v2 decision 2) and carry their own content; a dangling parent
 * link is honest history, not breakage.
 *
 * If a run WAS created in the race window, the return is `complete: false`
 * with the marker left in place — the same repeat-the-call resume contract
 * as runs: destroy the run, call again.
 */
export async function destroyCourseCascade(
  db: Firestore,
  courseId: string,
  actor: DestroyActor,
): Promise<DestroyCascadeResult> {
  const courseRef = db.collection("courses").doc(courseId);
  const preSnap = await courseRef.get();
  if (!preSnap.exists) {
    throw new Error(`courseDeletion: course ${courseId} not found`);
  }
  const preRaw = preSnap.data() ?? {};
  const course = normalizeCourse(preSnap.id, preRaw);
  const alreadyDestroying = readDestroyMarker(preRaw).destroying;

  if (!alreadyDestroying) {
    const blockers = await courseDestroyBlockers(db, course);
    if (blockers.length > 0) throw new DestroyBlockedError(blockers);
  }

  const manifestCounts = await countCourseDestroyTargets(db, course);

  const { auditRef, resumed } = await beginDestroy(
    db,
    courseRef,
    { status: "archived" },
    {
      kind: "course",
      targetId: courseId,
      targetLabel: course.title,
      startedAt: FieldValue.serverTimestamp(),
      startedByUid: actor.actorUid,
      startedByName: actor.actorName,
      manifestCounts,
      deleted: {},
      completedAt: null,
    },
  );

  // Same lease discipline as the run cascade: from here on, every exit hands
  // the audit row back.
  try {
    // The race re-check: a run created between the blocker check and the
    // marker landing must stop the course delete — the course doc going first
    // would orphan that run's courseId forever.
    const lateRuns = await db
      .collection("courseRuns")
      .where("courseId", "==", courseId)
      .limit(1)
      .get();
    if (!lateRuns.empty) {
      console.error(
        "[courseDeletion] a run appeared mid-destroy — leaving the course marked and incomplete:",
        courseId,
        lateRuns.docs[0].id,
      );
      await auditRef.update(PASS_LEASE_RELEASED);
      return {
        auditId: auditRef.id,
        deleted: await readAuditTotals(auditRef, {}),
        complete: false,
        resumed,
      };
    }

    const totals: Record<string, number> = { courses: 1 };
    const finalBatch = db.batch();
    finalBatch.update(auditRef, {
      ...auditIncrements(totals),
      ...PASS_LEASE_RELEASED,
      completedAt: FieldValue.serverTimestamp(),
    });
    finalBatch.delete(courseRef);
    await finalBatch.commit();

    return {
      auditId: auditRef.id,
      deleted: await readAuditTotals(auditRef, totals),
      complete: true,
      resumed,
    };
  } catch (err) {
    await auditRef.update(PASS_LEASE_RELEASED).catch(() => {});
    throw err;
  }
}
