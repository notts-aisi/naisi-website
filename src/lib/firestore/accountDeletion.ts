import "server-only";
import type { Auth } from "firebase-admin/auth";
import {
  FieldPath,
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from "firebase-admin/firestore";
import { normalizeCourseEnrolment } from "./courseEnrolments";
import {
  MEMBERSHIPS_COLLECTION,
  MEMBERSHIP_PERIODS_COLLECTION,
  isMembershipTier,
  type MembershipTier,
} from "./memberships";
import { REGISTRATIONS_COLLECTION } from "./registrations";
import { deleteEventsForSubscriptions } from "./subscriptions";

export type AccountDeletionSummary = {
  subscriptionsDeleted: number;
  registrationDeleted: boolean;
  collaboratorDeleted: boolean;
  userDocDeleted: boolean;
  emailVerificationsDeleted: number;
  courseApplicationsDeleted: number;
  courseEnrolmentsDeleted: number;
  courseProgressDeleted: number;
  courseExerciseResponsesDeleted: number;
  /** Scheduler markers naming this uid (deadline reminders, and anything a
   *  later job keys on a person). Deleted rather than kept: the audience row
   *  they suppress a send to is gone in the same cascade, so the marker can
   *  only ever be a dangling reference to a person who no longer exists. */
  schedulerMarkersDeleted: number;
  /**
   * Registers this member was removed FROM, never whole registers deleted.
   * Counts a document once even when it carried both an attendance mark and a
   * participant note about them (both keys go, in one batch).
   */
  courseAttendanceMarksCleared: number;
  /** Admission applications (drafts included) written by this account. */
  admissionApplicationsDeleted: number;
  /** Their access-requirements rows, deleted in the SAME batch. See below. */
  admissionApplicationPrivateDeleted: number;
  /** Review rows written ABOUT this account. */
  admissionReviewsDeleted: number;
  /** Review rows written BY this account about other people. */
  admissionReviewsAuthoredDeleted: number;
  /** Rounds this account was taken off as a reviewer or as the final decider. */
  admissionRoundRolesCleared: number;
  /**
   * Membership rows keyed on this uid, one per period. The PERIODS themselves
   * are not per-user and are never touched here: `membershipPeriods/2026-27`
   * describes a year of the society, not a person.
   */
  membershipsDeleted: number;
  conductFlagDeleted: boolean;
  authDeleted: boolean;
  /** Set when the teardown was not fully clean (a best-effort step failed, or the
   *  Auth account could not be deleted). Routes return 207 when this is present. */
  warning?: string;
};

// ---------------------------------------------------------------------------
// Course cascade helpers
// ---------------------------------------------------------------------------

/**
 * Rows per page for the course deletes. A learner accumulates one
 * `courseProgress` row per check-offable item per run (weeks × materials, so
 * hundreds across a couple of runs) and one `courseExerciseResponses` row per
 * exercise — comfortably past what one `.get()` + 500-write batch should carry,
 * which is why these two are paged rather than read whole.
 */
const COURSE_PAGE_SIZE = 300;

/**
 * Loop ceiling for the paged scans — 60 × 300 rows, far beyond any real
 * account. In `deleteOwnedCourseRows` it is only reachable if pages stop
 * shrinking (a write that reports success without deleting), so hitting it
 * THROWS rather than returning quietly: a silent stop would report a clean
 * teardown over rows that are still there, and the caller's best-effort catch
 * turns the throw into the 207 that keeps the tracker row for a retry.
 */
const COURSE_MAX_PAGES = 60;

/**
 * Rows per page for the admissions sweep, and deliberately NOT
 * `COURSE_PAGE_SIZE`.
 *
 * `deleteAdmissionApplications` commits TWO deletes per row in ONE batch (the
 * application and its `admissionApplicationPrivate` twin), and that single
 * batch is load-bearing rather than incidental: see that function for why the
 * two rows cannot be torn down by separate sweeps. A 300-row page would ask
 * one batch for up to 600 writes, past Firestore's 500-write cap, so the page
 * is the cap halved and rounded down. 250 × 2 = 500 exactly, and no real
 * account comes near even one page.
 */
const ADMISSION_PAGE_SIZE = 250;

/**
 * Delete every row a member owns in one `uid`-keyed collection, a page at a
 * time. (Named for the course collections it was written for; it is generic,
 * and the scheduler markers use it too.)
 *
 * No cursor: the rows are deleted as they are read, so the next query's first
 * page IS the next unprocessed page. That also makes a mid-way failure
 * resumable — a re-run picks up the smaller remainder — which is the property
 * the tracker row's keep-on-failure rule depends on.
 */
async function deleteOwnedCourseRows(
  db: Firestore,
  collection: string,
  uid: string,
  /**
   * The field naming the owner. Defaults to `uid`, which is what every
   * course collection uses. `admissionReviews` is the exception: it names the
   * account twice, once as `applicantUid` and once as `reviewerUid`, and both
   * sweeps are this same function with a different field.
   */
  field: string = "uid",
): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < COURSE_MAX_PAGES; page += 1) {
    const snap = await db
      .collection(collection)
      .where(field, "==", uid)
      .limit(COURSE_PAGE_SIZE)
      .get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    deleted += snap.size;
    if (snap.size < COURSE_PAGE_SIZE) return deleted;
  }
  throw new Error(`${collection} did not drain after ${COURSE_MAX_PAGES} pages`);
}

/**
 * How much to give each period back, worked out from the membership rows a
 * sweep deleted. Pure, so the arithmetic is testable without a Firestore.
 *
 * Keyed period id then tier, because a member holds at most one row per period
 * but a teardown can cross several periods at several tiers. A row with no
 * readable period id, or a tier the module does not know, is COUNTED NOWHERE:
 * the period's totals only ever moved for a recognised tier on the way in (see
 * the grant route), so moving them for an unrecognised one on the way out
 * would invent a decrement that no increment matches.
 */
export function membershipTotalsGivenBack(
  rows: readonly { periodId?: unknown; tier?: unknown }[],
): Map<string, Partial<Record<MembershipTier, number>>> {
  const back = new Map<string, Partial<Record<MembershipTier, number>>>();
  for (const row of rows) {
    const periodId = typeof row.periodId === "string" ? row.periodId : "";
    if (periodId === "" || !isMembershipTier(row.tier)) continue;
    const tiers = back.get(periodId) ?? {};
    tiers[row.tier] = (tiers[row.tier] ?? 0) + 1;
    back.set(periodId, tiers);
  }
  return back;
}

/**
 * Delete every membership row this account holds, and take each one back off
 * its period's cached per-tier totals.
 *
 * The PERIODS themselves are not swept and must not be:
 * `membershipPeriods/{periodId}` describes a year of the society and outlives
 * every account under it. Its `totals` map, though, is a cache the console
 * renders as a count of people, so leaving it holding rows that no longer
 * exist would have the membership page reporting a number an admin cannot
 * reconcile against anything. The grant route maintains those totals with
 * `increment(+1)` and `increment(-1)`; this is the same arithmetic for a row
 * that leaves without anybody pressing revoke.
 *
 * The deletes go first and the totals follow, one update per period rather
 * than one per row. A totals update that fails is LOGGED and does not fail the
 * teardown: the rows are already gone, which is the part that matters for the
 * person being deleted, and a count that is out by one is not a reason to keep
 * the account's registration row open for a retry.
 */
export async function deleteMembershipsAndAdjustTotals(
  db: Firestore,
  uid: string,
): Promise<number> {
  const deletedRows: { periodId?: unknown; tier?: unknown }[] = [];

  // Same no-cursor paging as `deleteOwnedCourseRows`: the rows are deleted as
  // they are read, so the next query's first page is the next unprocessed one.
  for (let page = 0; page < COURSE_MAX_PAGES; page += 1) {
    const snap = await db
      .collection(MEMBERSHIPS_COLLECTION)
      .where("uid", "==", uid)
      .limit(COURSE_PAGE_SIZE)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) {
      const data = d.data() ?? {};
      deletedRows.push({ periodId: data.periodId, tier: data.tier });
      batch.delete(d.ref);
    }
    await batch.commit();
    if (snap.size < COURSE_PAGE_SIZE) break;
    if (page === COURSE_MAX_PAGES - 1) {
      throw new Error(
        `${MEMBERSHIPS_COLLECTION} did not drain after ${COURSE_MAX_PAGES} pages`,
      );
    }
  }

  for (const [periodId, tiers] of membershipTotalsGivenBack(deletedRows)) {
    const update: Record<string, FirebaseFirestore.FieldValue> = {};
    for (const [tier, count] of Object.entries(tiers)) {
      update[`totals.${tier}`] = FieldValue.increment(-count);
    }
    try {
      await db.collection(MEMBERSHIP_PERIODS_COLLECTION).doc(periodId).update(update);
    } catch (err) {
      console.error("[deleteAccount] membership totals adjust failed:", periodId, err);
    }
  }

  return deletedRows.length;
}

/**
 * Remove a member from every attendance register on the given runs.
 *
 * A register is SHARED — one doc per (group, week), with the uid as a MAP KEY
 * inside `records` — so this deletes the key with `FieldPath`, never the doc.
 * Deleting the doc would erase the whole group's marks for that session, and a
 * dotted `"records.<uid>"` string would be reinterpreted as a nested path.
 *
 * `records` is not queryable by key, so the scan is per run (bounded by the
 * runs the member was actually enrolled on) and pages on doc id — nothing is
 * deleted here, so unlike `deleteOwnedCourseRows` this one needs a real cursor.
 *
 * `updatedAt` is deliberately untouched: it records when a facilitator last
 * marked the register, and a deletion elsewhere is not a marking.
 */
async function clearCourseAttendanceMarks(
  db: Firestore,
  runIds: string[],
  uid: string,
): Promise<number> {
  let cleared = 0;
  for (const runId of runIds) {
    let cursor: QueryDocumentSnapshot | null = null;
    let drained = false;
    for (let page = 0; page < COURSE_MAX_PAGES; page += 1) {
      let query = db
        .collection("courseAttendance")
        .where("runId", "==", runId)
        // Equality + `__name__` is served by the automatic single-field index;
        // no composite index is needed for this scan.
        .orderBy(FieldPath.documentId())
        .limit(COURSE_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;
      cursor = snap.docs[snap.docs.length - 1];

      // TWO map keys per register, not one. `participantNotes` (V3 W1 PR5)
      // is post-session prose ABOUT this member, written by their facilitator,
      // and it is personal data of exactly the kind an account deletion has to
      // take with it. Both keys are cleared by FieldPath on the SAME document,
      // in the same batch, for the same reason `records` always was: the
      // register is shared, so deleting the doc would erase the whole group's
      // session.
      //
      // A register can carry a note without a mark and a mark without a note
      // (a facilitator writes notes for the people they have something to say
      // about), so each key is tested separately and a document qualifies if
      // it holds either.
      const holds = (d: QueryDocumentSnapshot, field: string): boolean => {
        const map = (d.data() as Record<string, unknown>)[field];
        // `in` throws on a non-object, and a hand-edited register could carry
        // anything: a malformed map simply has no key to clear.
        return typeof map === "object" && map !== null && uid in map;
      };
      const marked = snap.docs.filter(
        (d) => holds(d, "records") || holds(d, "participantNotes"),
      );
      if (marked.length > 0) {
        const batch = db.batch();
        for (const d of marked) {
          if (holds(d, "records")) {
            batch.update(d.ref, new FieldPath("records", uid), FieldValue.delete());
          }
          if (holds(d, "participantNotes")) {
            batch.update(
              d.ref,
              new FieldPath("participantNotes", uid),
              FieldValue.delete(),
            );
          }
        }
        await batch.commit();
        cleared += marked.length;
      }
      if (snap.size < COURSE_PAGE_SIZE) {
        drained = true;
        break;
      }
    }
    // Throw rather than stop quietly, matching deleteOwnedCourseRows: a silent
    // stop would report the sweep as successful, and the caller uses that to
    // decide it may delete the enrolments — the only uid -> runIds index — and
    // then the tracker row. Marks left in a `if false` collection with nothing
    // naming the uid are unreachable.
    if (!drained) {
      throw new Error(`courseAttendance did not drain after ${COURSE_MAX_PAGES} pages`);
    }
  }
  return cleared;
}

/**
 * Delete this account's admission applications AND their access-requirements
 * rows, a page at a time.
 *
 * ## Why these two cannot be separate sweeps
 *
 * `admissionApplicationPrivate` holds the answer to "is there anything we
 * should know about access requirements?", which in practice means disability
 * and health information. It deliberately carries NOTHING but that answer
 * (no `uid`, no `roundId`), because the collection's whole design is that no
 * reader can join it by accident. The price of that is that it has no field
 * to query on: the ONLY handle back to a private row is the application id it
 * shares, `${roundId}__${uid}`.
 *
 * So a private sweep that ran after the applications were gone would have
 * nothing left to address, and the rows would sit in an
 * `allow read, write: if false` collection that nothing on the site could
 * name: the most sensitive text in the whole intake, permanently
 * unreachable and undeletable. The `clearCourseAttendanceMarks` ordering
 * lesson in its sharpest form.
 *
 * The answer is not "order them carefully": it is ONE BATCH. Each page
 * deletes the private rows and the applications that name them together, so
 * a failure leaves both, and a retry (re-reading the smaller remainder) is
 * the same operation again.
 *
 * That is also why the page size is `ADMISSION_PAGE_SIZE` (250) and not the
 * 300 the other course sweeps use: two deletes per row against Firestore's
 * 500-write batch cap.
 *
 * ## The counters are deliberately left alone
 *
 * Deleting an application does NOT move `admissionRounds.applicationCounts`.
 * That matches what this function already does for `courseApplications` and
 * `courseRuns.applicationCounts`, and the reason is the same: the counter is
 * moved inside the apply / submit / decide transactions, and an out-of-band
 * decrement here would be a second writer of a number those transactions
 * treat as theirs. Account deletion during a live intake is rare and
 * out-of-band by nature, and the round's recount route is the repair.
 * (Group `memberCount` IS decremented below, because a seat left held blocks
 * a real person from taking it.)
 */
async function deleteAdmissionApplications(
  db: Firestore,
  uid: string,
): Promise<{ applications: number; privateRows: number }> {
  let applications = 0;
  let privateRows = 0;
  for (let page = 0; page < COURSE_MAX_PAGES; page += 1) {
    const snap = await db
      .collection("admissionApplications")
      .where("uid", "==", uid)
      .limit(ADMISSION_PAGE_SIZE)
      .get();
    if (snap.empty) return { applications, privateRows };

    // Read the private rows before the batch only so the count is HONEST: a
    // `batch.delete` on a missing document succeeds silently, so counting the
    // refs rather than the documents would report rows that never existed.
    const privateRefs = snap.docs.map((d) =>
      db.collection("admissionApplicationPrivate").doc(d.id),
    );
    const livePrivate = (await db.getAll(...privateRefs)).filter((d) => d.exists);

    const batch = db.batch();
    for (const d of livePrivate) batch.delete(d.ref);
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();

    applications += snap.size;
    privateRows += livePrivate.length;
    if (snap.size < ADMISSION_PAGE_SIZE) return { applications, privateRows };
  }
  throw new Error(
    `admissionApplications did not drain after ${COURSE_MAX_PAGES} pages`,
  );
}

/**
 * Take a deleted account off every admission round that names it: out of
 * `reviewerUids`, and out of `finalDeciderUid` where it was the decider.
 *
 * ## Why this is not "tidying"
 *
 * A round outlives the accounts named on it, and until this ran, a deleted
 * reviewer left a uid on the round that nothing could resolve. The roles route
 * refuses a list naming an account that no longer exists, so the section
 * wedged: the admin could not see who the problem was (the picker draws names
 * from the member list, which no longer has them) and could not save a list
 * with them taken off either, because the same save has to clear
 * `users.admissionsReviewer` on everyone it removes and an update to a missing
 * user document rejects the whole batch. Both halves of that are fixed in the
 * route; this is the half that stops the state from arising at all.
 *
 * Both queries are single-field, so no composite index. Rounds are counted in
 * tens, so one batch is enough, and a round appearing in both queries takes
 * one update carrying both fields.
 */
export async function clearAdmissionRoundRoles(
  db: Firestore,
  uid: string,
): Promise<number> {
  const rounds = db.collection("admissionRounds");
  const [asReviewer, asDecider] = await Promise.all([
    rounds.where("reviewerUids", "array-contains", uid).get(),
    rounds.where("finalDeciderUid", "==", uid).get(),
  ]);

  const updates = new Map<string, Record<string, unknown>>();
  for (const doc of asReviewer.docs) {
    updates.set(doc.id, {
      ...(updates.get(doc.id) ?? {}),
      reviewerUids: FieldValue.arrayRemove(uid),
    });
  }
  for (const doc of asDecider.docs) {
    updates.set(doc.id, { ...(updates.get(doc.id) ?? {}), finalDeciderUid: null });
  }
  if (updates.size === 0) return 0;

  const batch = db.batch();
  for (const [roundId, fields] of updates) {
    batch.update(rounds.doc(roundId), {
      ...fields,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  return updates.size;
}

/**
 * Cascade-delete an account by uid — the single source of truth for "delete this
 * account," reused by the admin Members delete, the collaborator delete, the
 * admin registrations-tracker delete, and the self-service unfinished-account
 * delete. Centralising this is what fixes the ghost-row bug: every deletion path
 * now tears down the `registrations` tracker doc instead of leaving it dangling.
 *
 * Ordering rationale:
 *  - Subscription ROWS go first and are FATAL on failure — a surviving row would
 *    keep mailing a deleted user. Their append-only event log is best-effort
 *    (the rows are already gone, so a stale audit line is acceptable degradation,
 *    mirroring safeRecordEvent) and must NOT abort the rest of the teardown.
 *  - COURSE data goes before Auth for the same reason as everything else in the
 *    best-effort block: a failure there must not cost the caller the Auth
 *    deletion. Within it, attendance is cleared BEFORE the enrolments are
 *    deleted — the enrolments are what name the runs to scan — and the enrolment
 *    delete is SKIPPED OUTRIGHT when that sweep fails. Ordering alone is not
 *    enough, because the two steps are separately best-effort: the enrolment
 *    rows are the ONLY uid→runIds index in the data model, and `courseAttendance`
 *    is `allow read, write: if false`, so nothing (client or admin surface) can
 *    scan it for a uid once they are gone. Worse, the retry the 207 asks for
 *    would then read an EMPTY enrolment snapshot, sweep zero runs, report zero
 *    marks cleared WITHOUT failing, and clear the tracker row — a clean-looking
 *    200 over marks that are now unreachable and unnameable. So the dependency
 *    is enforced in code, not merely implied by the order of the two blocks.
 *  - The Auth user is deleted near-LAST so a late failure leaves at worst a
 *    benign Auth orphan, never a half-account with dangling profile docs. If Auth
 *    deletion fails the account survives, so its refresh tokens are revoked
 *    (best-effort) — otherwise a "deleted" account keeps live sessions elsewhere.
 *  - The `registrations` tracker row is deleted ONLY AFTER a FULLY CLEAN teardown
 *    (Auth gone AND no best-effort step failed). If anything was left behind, the
 *    row is intentionally kept so the orphan stays visible in the tracker for a
 *    retry — clearing it would strand untracked residue (e.g. PII-bearing
 *    emailVerifications tokens) invisible to the very tool built to surface it.
 *    A re-run is idempotent (auth/user-not-found counts as success) and clears
 *    the row once the failed step succeeds.
 *
 * SCOPE: deletes registration-stage + identity data — subscriptions (+ their
 * event log), the registrations row, the collaborators doc, the users doc, the
 * account's email-verification token docs, and the Auth user. It deliberately
 * does NOT delete a member's substantive content (tasks, comments, attachments,
 * events, RSVPs, bookings). That's the deferred hygiene sweep, and retaining
 * content for a period after deletion is the intended behaviour (a privacy-policy
 * retention clause is backburnered).
 *
 * COURSE DATA IS THE ONE EXCEPTION, and deliberately so. Every course row is
 * keyed to the uid rather than owned by a doc anyone can still administer:
 * `courseApplications` carries the applicant's EMAIL and a denormalised name,
 * `courseProgress` carries public comments the whole cohort reads,
 * `courseExerciseResponses` carries member-authored text a facilitator queue
 * serves, and `courseAttendance` carries participation marks. With the users
 * doc gone every one of those renders as an anonymous ghost row ("NAISI
 * member") that no admin surface can find or clear — so they go with the
 * account rather than waiting for a sweep that could no longer name them.
 *
 * ADMISSIONS DATA GOES FOR THE SAME REASON, and one part of it goes for a
 * stronger one. `admissionApplications` carries the essays and the email;
 * `admissionReviews` carries other people's written assessments of this
 * person, and this person's written assessments of others;
 * `memberConductFlags` carries a free-text allegation. All are keyed to the
 * uid alone. And `admissionApplicationPrivate` holds the access-requirements
 * answer, which will in practice contain disability and health information
 * and which has NO field to query on by design; see
 * `deleteAdmissionApplications` for why that makes it the one row that must
 * die in the same batch as its application rather than in a sweep of its own.
 * The reviewer-authored retention decision is argued at its call site rather
 * than left silent.
 *
 * MIRRORED MY WORK TASKS ARE RETAINED. The week-mirror writes `tasks/{id}` docs
 * (courseTasks.ts) which look like course data but are ordinary task rows — the
 * member is creator and sole completer, `assignees-only`, dismissible like any
 * quick-add. They belong to the tasks collection, which the deferred hygiene
 * sweep owns end to end; carving one `source: "fellowship-reminder"` slice out
 * of it here would leave the member's other tasks behind while breaking the
 * blocks/comments/activity a task carries, and would put this function in the
 * business of deleting content the retention decision above says to keep.
 */
export async function deleteAccountCascade(
  auth: Auth,
  db: Firestore,
  uid: string,
): Promise<AccountDeletionSummary> {
  const summary: AccountDeletionSummary = {
    subscriptionsDeleted: 0,
    registrationDeleted: false,
    collaboratorDeleted: false,
    userDocDeleted: false,
    emailVerificationsDeleted: 0,
    courseApplicationsDeleted: 0,
    courseEnrolmentsDeleted: 0,
    courseProgressDeleted: 0,
    courseExerciseResponsesDeleted: 0,
    schedulerMarkersDeleted: 0,
    courseAttendanceMarksCleared: 0,
    admissionApplicationsDeleted: 0,
    admissionApplicationPrivateDeleted: 0,
    admissionReviewsDeleted: 0,
    admissionReviewsAuthoredDeleted: 0,
    admissionRoundRolesCleared: 0,
    membershipsDeleted: 0,
    conductFlagDeleted: false,
    authDeleted: false,
  };
  // Tracks whether any best-effort step (2-5) failed after attempting, so we can
  // surface it (207) and keep the tracker row for re-cleanup.
  let partialFailure = false;

  // 1. Subscription ROWS (audience=user, audienceId=uid). FATAL on failure —
  //    abort before deleting anything else so we never strand a row that would
  //    keep mailing a deleted user.
  let ownedSubIds: string[] = [];
  try {
    const snap = await db.collection("subscriptions").where("audienceId", "==", uid).get();
    const owned = snap.docs.filter(
      (d) => (d.data() as { audience?: string }).audience === "user",
    );
    if (owned.length > 0) {
      const batch = db.batch();
      for (const d of owned) batch.delete(d.ref);
      await batch.commit();
      summary.subscriptionsDeleted = owned.length;
      ownedSubIds = owned.map((d) => d.id);
    }
  } catch (err) {
    console.error("[deleteAccount] subscription row delete failed:", uid, err);
    throw new Error("Failed to delete the account's subscription rows; nothing else was removed.");
  }

  // 1b. Their append-only event log. BEST-EFFORT: the rows (the mailing source)
  //     are already gone, so a failure here is acceptable degradation and must
  //     not abort the cascade.
  if (ownedSubIds.length > 0) {
    try {
      await deleteEventsForSubscriptions(db, ownedSubIds);
    } catch (err) {
      console.error("[deleteAccount] subscriptionEvents cleanup failed (best-effort):", uid, err);
    }
  }

  // 2. collaborators doc (id is name-slug__uid, so query the uid field).
  try {
    const snap = await db.collection("collaborators").where("uid", "==", uid).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.delete();
      summary.collaboratorDeleted = true;
    }
  } catch (err) {
    console.error("[deleteAccount] collaborator delete failed:", uid, err);
    partialFailure = true;
  }

  // 3. users/{uid} doc.
  try {
    const userRef = db.collection("users").doc(uid);
    if ((await userRef.get()).exists) {
      await userRef.delete();
      summary.userDocDeleted = true;
    }
  } catch (err) {
    console.error("[deleteAccount] user doc delete failed:", uid, err);
    partialFailure = true;
  }

  // 4. emailVerifications token docs (login-email + uni-email both carry authUid).
  //    These hold the account's email PII and, for unfinished accounts, an
  //    unverified login-email token a same-email re-registration could match.
  try {
    const snap = await db.collection("emailVerifications").where("authUid", "==", uid).get();
    if (!snap.empty) {
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
      summary.emailVerificationsDeleted = snap.size;
    }
  } catch (err) {
    console.error("[deleteAccount] emailVerifications delete failed:", uid, err);
    partialFailure = true;
  }

  // 5. Course data (see the SCOPE note). Each collection is its own try so one
  //    failure doesn't cost the others, and all of it is BEST-EFFORT: the rows
  //    are content, not a mailing source, and a 207 keeps the tracker row so the
  //    remainder can be re-run.
  //
  //    Read once, up front: these rows name the runs the attendance scan needs
  //    AND the group seats the counter decrement has to release, so 5a and 5b
  //    work off the same snapshot. 5c does not need it and runs regardless.
  let enrolSnap: QuerySnapshot | null = null;
  try {
    enrolSnap = await db.collection("courseEnrolments").where("uid", "==", uid).get();
  } catch (err) {
    console.error("[deleteAccount] courseEnrolments read failed:", uid, err);
    partialFailure = true;
  }

  if (enrolSnap) {
    const enrolments = enrolSnap.docs.map((d) =>
      normalizeCourseEnrolment(d.id, d.data() ?? {}),
    );

    // 5a. Attendance marks — BEFORE the enrolments go, since they are what name
    //     the runs to scan (see the ordering rationale).
    let attendanceSwept = false;
    try {
      const runIds = [...new Set(enrolments.map((e) => e.runId).filter(Boolean))];
      summary.courseAttendanceMarksCleared = await clearCourseAttendanceMarks(
        db,
        runIds,
        uid,
      );
      attendanceSwept = true;
    } catch (err) {
      console.error("[deleteAccount] courseAttendance clear failed:", uid, err);
      partialFailure = true;
    }

    // 5b. Enrolments — ONLY once 5a has actually succeeded. These rows are the
    //     uid→runIds index the attendance sweep runs off, so deleting them after
    //     a failed sweep would strand marks in a collection nothing can scan by
    //     uid AND make the retry report a clean teardown (see the ordering
    //     rationale). Keeping them costs a 207 and a re-run; dropping them is
    //     unrecoverable, so the failed step keeps its own input alive.
    //
    //     The group `memberCount` decrement rides in the SAME batch so the
    //     counter can never drift from the rows it summarises. A seat is held
    //     only by an enrolment that is both active AND grouped — the
    //     allocate/remove routes' definition — so a withdrawn row releases
    //     nothing here; its seat went when it left "active".
    //
    //     The run's `enrolledCount` rides along too, and its condition is
    //     NARROWER: `selfEnrolled` as well as active. That field is moved only
    //     by the open-enrol route, which increments it when somebody takes a
    //     seat themselves and decrements it when they leave. Decrementing it
    //     for an allocated admissions learner, whose row nothing ever counted,
    //     would drive it negative and then wedge the enrol-mode route, which
    //     reads it as "is anybody on this run". Rows the counter never counted
    //     are rows it must not uncount.
    if (!attendanceSwept) {
      console.error(
        "[deleteAccount] courseEnrolments delete SKIPPED — the attendance sweep failed and these rows are the only index back to the runs to re-scan:",
        uid,
      );
    } else {
      try {
        const seats = new Map<string, number>();
        const selfEnrolledByRun = new Map<string, number>();
        for (const e of enrolments) {
          if (e.status !== "active") continue;
          if (e.groupId) {
            seats.set(e.groupId, (seats.get(e.groupId) ?? 0) + 1);
          }
          if (e.selfEnrolled && e.runId) {
            selfEnrolledByRun.set(
              e.runId,
              (selfEnrolledByRun.get(e.runId) ?? 0) + 1,
            );
          }
        }
        // A group doc that has since been deleted would make `batch.update`
        // reject the WHOLE batch and strand the enrolments, so absent groups are
        // skipped rather than assumed. At most one group per run — a trivial read.
        const groupIds = [...seats.keys()];
        const groupDocs = groupIds.length
          ? await db.getAll(...groupIds.map((id) => db.collection("courseGroups").doc(id)))
          : [];
        const liveGroupIds = new Set(groupDocs.filter((d) => d.exists).map((d) => d.id));

        // Same absent-doc rule as the groups above: a run deleted since the
        // enrolment was written must not make `batch.update` reject the whole
        // batch and strand every row in it.
        const runIds = [...selfEnrolledByRun.keys()];
        const runDocs = runIds.length
          ? await db.getAll(...runIds.map((id) => db.collection("courseRuns").doc(id)))
          : [];
        const liveRunIds = new Set(runDocs.filter((d) => d.exists).map((d) => d.id));

        if (enrolSnap.size > 0) {
          const batch = db.batch();
          for (const d of enrolSnap.docs) batch.delete(d.ref);
          for (const [groupId, count] of seats) {
            if (!liveGroupIds.has(groupId)) continue;
            batch.update(db.collection("courseGroups").doc(groupId), {
              memberCount: FieldValue.increment(-count),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          for (const [runId, count] of selfEnrolledByRun) {
            if (!liveRunIds.has(runId)) continue;
            batch.update(db.collection("courseRuns").doc(runId), {
              enrolledCount: FieldValue.increment(-count),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
          summary.courseEnrolmentsDeleted = enrolSnap.size;
        }
      } catch (err) {
        console.error("[deleteAccount] courseEnrolments delete failed:", uid, err);
        partialFailure = true;
      }
    }
  }

  // 5c. Applications (email + denormalised name), progress rows (public
  //     comments and private notes), exercise responses (member-authored
  //     answers). All addressed by their own `uid` field, so these run whether
  //     or not the enrolment read above succeeded. The last two are paged — a
  //     learner accrues one row per check-offable item and per exercise, per run.
  //
  //     `schedulerMarkers` rides the same loop: markers store every component
  //     of their id as a field, so the person-keyed families (today the
  //     admissions deadline reminder, `remind__{roundId}__{uid}__{dueAtKey}`)
  //     are addressable by `uid` exactly like the rows above. They are
  //     deleted rather than retained because a marker's only job is to
  //     suppress a send to an audience row this cascade has already removed.
  for (const [collection, key] of [
    ["courseApplications", "courseApplicationsDeleted"],
    ["courseProgress", "courseProgressDeleted"],
    ["courseExerciseResponses", "courseExerciseResponsesDeleted"],
    ["schedulerMarkers", "schedulerMarkersDeleted"],
  ] as const) {
    try {
      summary[key] = await deleteOwnedCourseRows(db, collection, uid);
    } catch (err) {
      console.error(`[deleteAccount] ${collection} delete failed:`, uid, err);
      partialFailure = true;
    }
  }

  // 5d. ADMISSIONS. Same tier as the course rows above and for the same
  //     reason: every one of these is keyed to the uid rather than owned by
  //     a document somebody can still administer, so with the users doc gone
  //     they are ghost rows no admin surface could find. Each is its own try
  //     so one failure does not cost the others.
  try {
    const { applications, privateRows } = await deleteAdmissionApplications(db, uid);
    summary.admissionApplicationsDeleted = applications;
    summary.admissionApplicationPrivateDeleted = privateRows;
  } catch (err) {
    console.error("[deleteAccount] admissionApplications delete failed:", uid, err);
    partialFailure = true;
  }

  // Review rows ABOUT this account: scores and free-text notes describing a
  // person who no longer has an account. They go with the applications they
  // assess.
  try {
    summary.admissionReviewsDeleted = await deleteOwnedCourseRows(
      db,
      "admissionReviews",
      uid,
      "applicantUid",
    );
  } catch (err) {
    console.error("[deleteAccount] admissionReviews (applicant) failed:", uid, err);
    partialFailure = true;
  }

  // Review rows written BY this account about OTHER people.
  //
  // RETENTION DECISION, stated rather than left to inference: these are
  // DELETED too. The argument for keeping them is that they are somebody
  // else's decision record. The argument that wins is that the row is
  // personal data about the REVIEWER as well as the applicant (it is their
  // named judgement, their free text, and the queue attributes it to them by
  // uid), and that with the reviewer's account gone it attributes itself to
  // an id nothing can resolve. Keeping it would mean an anonymous score of
  // unknown provenance sitting in a decision aggregate, which is worse for
  // the applicant than one fewer review: the coverage filter would count a
  // reviewer who no longer exists as having covered them.
  //
  // Reviews are scored during a round and decided at the end of it, so the
  // realistic case is an account deleted long after the round settled, where
  // the decision has already been made and mailed. A reviewer who deletes
  // their account MID-round leaves an application short of coverage, which
  // the queue's coverage filter surfaces as work to redo: visible, and the
  // right answer.
  try {
    summary.admissionReviewsAuthoredDeleted = await deleteOwnedCourseRows(
      db,
      "admissionReviews",
      uid,
      "reviewerUid",
    );
  } catch (err) {
    console.error("[deleteAccount] admissionReviews (reviewer) failed:", uid, err);
    partialFailure = true;
  }

  // The rounds that NAME this account: its reviewer lists and its final
  // decider. Unlike everything else in this block these are not rows the
  // account owns, they are references to it on documents that outlive it, and
  // a reference nothing can resolve is what wedged the roles section.
  try {
    summary.admissionRoundRolesCleared = await clearAdmissionRoundRoles(db, uid);
  } catch (err) {
    console.error("[deleteAccount] admissionRounds role clear failed:", uid, err);
    partialFailure = true;
  }

  // The conduct flag. Addressed at the uid, so no query and no index. It
  // carries a free-text allegation about a named person, which has no reason
  // to outlive the account it describes.
  try {
    const flagRef = db.collection("memberConductFlags").doc(uid);
    if ((await flagRef.get()).exists) {
      await flagRef.delete();
      summary.conductFlagDeleted = true;
    }
  } catch (err) {
    console.error("[deleteAccount] memberConductFlags delete failed:", uid, err);
    partialFailure = true;
  }

  // 5e. MEMBERSHIP rows: one per period this account was recorded a member for.
  //     Paged on the `uid` field like the course sweeps above, because a long
  //     membership history is several rows rather than one addressed document.
  //
  //     Each row also comes back off its period's cached per-tier totals,
  //     which the console renders as a headcount. The periods themselves are
  //     left alone: they describe a year of the society and outlive every
  //     account under them. See `deleteMembershipsAndAdjustTotals`.
  //
  //     `users.paidMembershipYears` needs no step of its own: the whole user
  //     document goes in step 3.
  try {
    summary.membershipsDeleted = await deleteMembershipsAndAdjustTotals(db, uid);
  } catch (err) {
    console.error("[deleteAccount] memberships delete failed:", uid, err);
    partialFailure = true;
  }

  // 6. Firebase Auth user. Already-gone counts as success.
  try {
    await auth.deleteUser(uid);
    summary.authDeleted = true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "auth/user-not-found") {
      summary.authDeleted = true;
    } else {
      console.error("[deleteAccount] Auth delete failed:", uid, err);
      summary.warning = "Account data removed, but the Auth account could not be deleted.";
      // The account survives, so its sessions/refresh tokens are still live on
      // every device. Best-effort revoke so a "deleted" account can't keep
      // authenticating elsewhere until a retry actually removes it.
      try {
        await auth.revokeRefreshTokens(uid);
      } catch (revokeErr) {
        console.error("[deleteAccount] revokeRefreshTokens failed:", uid, revokeErr);
      }
    }
  }

  // 7. registrations/{uid} tracker row — ONLY on a fully clean teardown (Auth gone
  //    AND no best-effort step failed). Otherwise keep the row so the orphan stays
  //    surfaced in the tracker; a re-run (idempotent) retries the failed step and
  //    then clears it.
  if (summary.authDeleted && !partialFailure) {
    try {
      await db.collection(REGISTRATIONS_COLLECTION).doc(uid).delete();
      summary.registrationDeleted = true;
    } catch (err) {
      console.error("[deleteAccount] registrations delete failed:", uid, err);
      partialFailure = true;
    }
  }

  // A swallowed best-effort failure is still a non-clean delete — surface it as a
  // warning (→ 207) so callers don't report a clean success.
  if (partialFailure && !summary.warning) {
    summary.warning =
      "Some account data couldn't be removed; the registration row was kept so the deletion can be retried.";
  }

  return summary;
}
