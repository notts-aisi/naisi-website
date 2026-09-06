import "server-only";
import { FieldValue, type Firestore, type Query } from "firebase-admin/firestore";
import { APPLICATIONS_COLLECTION } from "@/lib/firestore/admissionApplications";
import {
  ROUNDS_COLLECTION,
  type AdmissionRoundDoc,
} from "@/lib/firestore/admissionRounds";
import { DATA_EXPORTS_COLLECTION } from "@/lib/firestore/dataExports";
import {
  DESTROY_AUDITS_COLLECTION,
  accumulateDestroyAudit,
  claimDestroyAuditPass,
  completeDestroyAudit,
  openDestroyAudit,
  readDestroyAuditTotals,
  readInterruptedDestroyAudit,
  releaseDestroyAuditPass,
} from "@/lib/firestore/destroyAudit";
import { STAGES_SUBCOLLECTION } from "./roundRoutes";
import { writeRecordsForRound } from "./memberRecordSync";

/**
 * DESTROY an admission round: the irreversible end of an intake.
 *
 * A round can be CANCELLED, and cancelling is the everyday way to call one
 * off. It is a status, it keeps every application and every review readable
 * as history, and it is what an intake that did not happen should get.
 * Destroy is for the other cases: a round created by mistake, a test round on
 * dev, and data somebody has decided must not be retained. It removes the
 * round, its stages, every application on it with the access-requirements row
 * beside it, and every review written about those applications.
 *
 * This module is the engine. The routes own WHO and WHETHER (admin only, a
 * byte-equal typed confirmation, the refusal sentences); everything below
 * owns WHAT and IN WHAT ORDER, and it is written to the shape
 * `courseDeletion.ts` established for course runs, because a second dialect
 * of "how a destroy behaves" would be a second set of crash properties for
 * anybody to reason about. Same audit-row-first rule, same budgeted
 * delete-as-you-read pages, same resume-by-repeating-the-call contract, same
 * drained-guard throw.
 *
 * ## THE MEMBER RECORD IS WRITTEN FIRST, AND A FAILURE THERE REFUSES
 *
 * The rule this whole feature was built around: a destroy never deletes what
 * the committee wants to remember about a PERSON. Before a single document is
 * deleted, `writeRecordsForRound` makes sure each applicant has a record at
 * `memberRecords/{uid}/applications/{roundId}`: when they applied, what for,
 * the outcome, the score summary and the reviewers' notes as plain text. If
 * any one of those writes fails the cascade REFUSES and nothing is deleted
 * (`MemberRecordWriteError` → 409), because the alternative is a destroy that
 * quietly forgets one person.
 *
 * It writes the entries that are MISSING and leaves the ones that are already
 * there untouched. That is not an optimisation: rewriting a settled entry
 * would rebuild its reviewer notes from the reviews that survive today, and a
 * reviewer who has since deleted their account has had their reviews deleted
 * with it, so the rewrite would drop an assessment the settle had safely
 * preserved. `memberRecordSync.ts` argues that at length; the important
 * consequence here is that a destroy of a settled round normally writes
 * nothing and that is the healthy case, not a sweep that failed to run.
 *
 * It runs once per destroy rather than once per pass. The audit row carries
 * `recordsWrittenAt` as proof that the sweep finished, and a resume that
 * finds it skips the sweep: every application on the round is recorded before
 * anything is deleted, so the applications a resume still finds are a subset
 * of ones already recorded. A pass that died part-way through the sweep never
 * stamps it, so the resume runs it again.
 *
 * ## THE ROUND IS MARKED BEFORE THE FIRST DELETE
 *
 * Once the records are safe and before anything is removed, the round document
 * gets `destroying: true` and the audit id. A destroy runs in pages, so a big
 * round can be half gone between passes, and without the marker that half-gone
 * round is indistinguishable from a live closed one: the status route would
 * take `closed -> open` on it, `roundReadiness` would pass (the stages drain
 * last, so they are still there), and real applicants would file applications
 * into a round whose next resume deletes them. The status route refuses every
 * transition on a marked round, and the marker goes when the round document
 * does.
 *
 * ## What is NOT touched
 *
 * - `courseRuns` and the seat rows on them. A round feeds runs; the runs
 *   outlive it, and a member sitting on a cohort keeps their place when the
 *   intake that put them there is destroyed. The run destroy is the other
 *   direction of that relationship and it releases seats rather than deleting
 *   applications, for the mirror-image reason.
 * - `emailSends`. The append-only delivery log is evidence about messages
 *   that reached people's inboxes and outlives the round they mention. It is
 *   COUNTED on the manifest and never deleted.
 * - `dataExports`. The append-only record of which spreadsheets were taken
 *   off the platform and by whom. Counted, never deleted, same reasoning.
 * - `memberRecords`. The point of the exercise.
 * - `schedulerMarkers`. The two families that name a round
 *   (`remind__{roundId}__…` and `stagerel__{roundId}__…`) are dedupe rows with
 *   no member content, and a round id is a slug with a RANDOM SUFFIX, so a
 *   marker left behind can never suppress a send on a LATER round the way a
 *   group-keyed marker can (which is why the run cascade does drain those).
 *   That argument is the whole reason they are left; the retention policy is
 *   not part of it. `SCHEDULER_MARKER_RETENTION_DAYS` is inert until an owner
 *   creates a TTL policy per project, and only a SETTLED marker is given an
 *   `expiresAt` at all (`schedulerMarkers.ts`), so a marker left claimed but
 *   unsettled by a round that has gone may sit there for good. Harmless, by
 *   the random-suffix argument, and cheaper than a manifest line the dialog
 *   would have to explain.
 * - `courseAudit`. The decide route writes a line naming the appointee when
 *   somebody is made a facilitator out of a round, and that line survives.
 *   It is keyed to the RUN rather than the round, it is the run's operational
 *   history rather than the intake's, and the run outlives the round for the
 *   same reason the seats do. It is applicant-identifying text, so it is
 *   named here rather than left to be discovered; it is not on the manifest
 *   because the manifest's retained lines are the two append-only logs the
 *   round itself wrote.
 *
 * ## No email
 *
 * Nothing here sends anything. Applicants are not told a round was destroyed:
 * there is no honest message to send them, and telling somebody their
 * application has been deleted is a conversation a person should have, not a
 * template.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Rows per page for the review and stage drains. Applications page smaller
 * (below) because each one commits two deletes.
 */
const DESTROY_PAGE_SIZE = 250;

/**
 * Applications per page. Each row commits its own delete AND the delete of
 * its `admissionApplicationPrivate` twin in the same batch, against
 * Firestore's 500-write cap. That is the `accountDeletion.ts` arithmetic, restated
 * here because the reason is the pairing rather than the collection.
 */
const APPLICATION_PAGE_SIZE = 200;

/**
 * Documents one invocation may delete before returning `complete: false`.
 * A round is a few hundred rows at the very most, so this is sized to finish
 * an ordinary destroy in one call while keeping a pathological one off a
 * request that Cloud Run will kill at sixty seconds.
 */
const DESTROY_DOC_BUDGET = 500;

/**
 * Full-pass ceiling for the drain loop. Pass one does the work and pass two
 * is the empty verify pass; more than a handful means rows are being created
 * as fast as they are deleted, and the honest answer is a throw rather than a
 * busy loop (the `courseDeletion.ts` drained-guard, same reasoning).
 */
const MAX_PASSES = 5;

/** The audit kind this engine writes. Shared vocabulary; see destroyAudit.ts. */
const AUDIT_KIND = "admission-round" as const;

/** `admissionReviews`, as a literal. See the note in memberRecordSync.ts. */
const REVIEWS_COLLECTION = "admissionReviews";

/** `admissionApplicationPrivate`, addressed only, never queried. */
const APPLICATION_PRIVATE_COLLECTION = "admissionApplicationPrivate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Everything a round destroy touches, counted LIVE at request time. The keys
 * are the shared count vocabulary and the manifest renders them in that
 * language, so two of them are worth reading twice:
 *
 * `memberRecordEntriesWritten` is NOT a deletion. It is the number of member
 * records this destroy guarantees before it removes anything, which is the
 * number of applications, because every application owes one. The destroy
 * writes the ones that are missing and leaves the ones already on file alone,
 * so the WRITES it actually makes can be fewer (usually zero, on a round that
 * settled); this number is the promise, not the write count, and the dialog
 * must present it as what survives rather than as what dies.
 *
 * `reviewerFlagsCleared` is not a deletion either: it is a boolean set to
 * false on some people's own user documents, which changes what their sidebar
 * offers and removes nothing.
 *
 * `emailSendRows` and `dataExportRows` are COUNTED AND KEPT. The dialog must
 * present both as history that outlives the round, never as part of what
 * dies.
 */
export type RoundDestroyCounts = {
  applications: number;
  /** The access-requirements rows, addressed by their application's id. */
  applicationPrivateRows: number;
  reviews: number;
  stages: number;
  /** Records guaranteed before anything is deleted. Not a deletion. */
  memberRecordEntriesWritten: number;
  /** People who lose the Admissions nav flag because nothing else names them. */
  reviewerFlagsCleared: number;
  /** Retained: the append-only delivery log. */
  emailSendRows: number;
  /** Retained: the append-only record of what was downloaded. */
  dataExportRows: number;
};

export type DestroyActor = {
  actorUid: string;
  /** Display name, never an email: the audit row is PII-light on purpose. */
  actorName: string;
};

export type RoundDestroyResult = {
  auditId: string;
  /**
   * The audit row's ACCUMULATED totals for this destroy, not this pass's, and
   * DELETIONS ONLY.
   *
   * Nothing that is not a deletion goes in here, and the reason is the receipt:
   * the dialog prints every key of this map under the sentence "and the records
   * listed below no longer exist". A destroy that ended by telling the admin
   * "member record entries written: 2" among the things that no longer exist
   * would be denying the one promise that makes it allowable. The audit row's
   * `deleted` map is the same map and carries the same rule; the writes that
   * are not deletions live in `writes`.
   */
  deleted: Record<string, number>;
  /**
   * The writes this destroy made that removed no rows: member records written,
   * records already on file it left alone, and reviewer nav flags cleared.
   * Accumulated on the audit row as its own top-level fields, never under
   * `deleted`, and reported separately so no surface can render them as losses.
   */
  writes: Record<string, number>;
  /** False = the page budget ran out; repeat the SAME call to resume. */
  complete: boolean;
  /** True when this call resumed a destroy an earlier one had begun. */
  resumed: boolean;
};

/**
 * Thrown when a destroy is refused outright. The routes map it to 409 with
 * the sentences intact. Only a FRESH destroy is ever blocked: a resume must
 * not re-evaluate blockers, because the decision has been made and half the
 * data is already gone, so re-blocking would wedge an interrupted cascade for
 * good.
 */
export class RoundDestroyBlockedError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(blockers[0] ?? "This destroy is blocked.");
    this.name = "RoundDestroyBlockedError";
    this.blockers = blockers;
  }
}

/**
 * Thrown when the member records could not all be written. The cascade throws
 * this BEFORE it deletes anything, and the route turns it into a 409 that
 * names the people whose record failed, because the whole reason a destroy is
 * allowed to remove an intake is that the committee keeps the part of it that
 * is about a person.
 */
export class MemberRecordWriteError extends Error {
  /** Named, not just addressed: a list of uids is not an answer to an admin. */
  readonly failed: { uid: string; name: string; message: string }[];
  constructor(failed: { uid: string; name: string; message: string }[]) {
    super(
      `Nothing was deleted: the member record could not be written for ${failed.length} ${failed.length === 1 ? "applicant" : "applicants"}. A destroy never removes what the committee keeps about a person, so it refuses until every record is safely written.`,
    );
    this.name = "MemberRecordWriteError";
    this.failed = failed;
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

type Budget = { remaining: number };

type DrainResult = { deleted: number; drained: boolean };

async function countAgg(query: Query): Promise<number> {
  return (await query.count().get()).data().count;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Drain one collection query with delete-as-you-read pagination. There is no
 * cursor to persist: deleting the page makes the next query's first page the
 * next unprocessed page, which is the property the whole resume contract
 * rides on.
 *
 * The repeated-first-id guard THROWS rather than stopping quietly. A delete
 * that is not taking effect would otherwise loop while the audit row inflated
 * over rows that are still there, and a destroy reporting a clean sweep over
 * surviving applications is the one outcome worse than a visible failure.
 */
async function drainQuery(
  db: Firestore,
  label: string,
  buildQuery: () => Query,
  budget: Budget,
  pageSize = DESTROY_PAGE_SIZE,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(pageSize, budget.remaining);
    const snap = await buildQuery().limit(limit).get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        `admissionsDestroy: ${label} page did not shrink after a committed delete, ` +
          "aborting rather than looping (a silent stop would report progress over rows that are still there)",
      );
    }
    prevFirstId = firstId;

    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.size;
    budget.remaining -= snap.size;

    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/**
 * Drain the round's applications AND their access-requirements rows, one page
 * at a time, both halves in ONE batch.
 *
 * This is the `accountDeletion.ts` pairing rule, and it is not tidiness.
 * `admissionApplicationPrivate` holds the answer to "is there anything we
 * should know about access requirements", which in practice is disability and
 * health information. The collection deliberately carries nothing but that
 * answer (no uid, no roundId), so no reader can join it by accident, and the
 * price of that design is that the ONLY handle back to a private row is the
 * application id it shares. Delete the applications first and those rows are
 * stranded for good in a collection nothing on the site can name.
 *
 * So they travel together: a failure leaves both, and the retry is the same
 * operation over the smaller remainder.
 *
 * The private rows are READ before the batch only so the count is honest:
 * `batch.delete` on a missing document succeeds silently, so counting refs
 * would report rows that never existed.
 *
 * The two counts are returned separately because the manifest names them
 * separately, and `extra` is where the private total lands: the drain
 * contract is one number per stage, and the private rows are charged no
 * budget of their own (there is at most one per application, so the
 * applications already bound them).
 */
async function drainApplications(
  db: Firestore,
  roundId: string,
  budget: Budget,
  extra: Record<string, number>,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(APPLICATION_PAGE_SIZE, budget.remaining);
    const snap = await db
      .collection(APPLICATIONS_COLLECTION)
      .where("roundId", "==", roundId)
      .limit(limit)
      .get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        "admissionsDestroy: applications page did not shrink after a committed delete, " +
          "aborting rather than looping (a silent stop would report progress over rows that are still there)",
      );
    }
    prevFirstId = firstId;

    const privateRefs = snap.docs.map((doc) =>
      db.collection(APPLICATION_PRIVATE_COLLECTION).doc(doc.id),
    );
    const livePrivate = (await db.getAll(...privateRefs)).filter((doc) => doc.exists);

    const batch = db.batch();
    for (const doc of livePrivate) batch.delete(doc.ref);
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();

    deleted += snap.size;
    budget.remaining -= snap.size;
    extra.applicationPrivateRows =
      (extra.applicationPrivateRows ?? 0) + livePrivate.length;

    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

// ---------------------------------------------------------------------------
// The reviewer nav flag
// ---------------------------------------------------------------------------

/**
 * The people who lose `users.admissionsReviewer` when this round goes.
 *
 * ONE predicate, used by the manifest and by the cascade, so the number an
 * admin reads and the number of people whose sidebar changes cannot disagree.
 * It reproduces the roles route's rule exactly: a person keeps the flag if
 * ANOTHER round still names them as a reviewer or as its final decider. This
 * round is excluded by id, which is what lets the sweep run while the round
 * document is still there.
 *
 * Every round is read in one query rather than two queries per person: a
 * round names up to forty reviewers, and rounds are counted in tens. The read
 * is projected down to the two fields the answer needs.
 *
 * Two filters after that, and both are load-bearing rather than defensive:
 *
 *  - the user document must EXIST. `batch.update` on a missing document
 *    rejects the whole batch, so one deleted account among the reviewers
 *    would take the entire flag sweep down with it (the roles route learned
 *    this the same way). A deleted account's flag went with its document.
 *  - the flag must currently be `true`. Clearing a flag that is already false
 *    is a write that changes nothing, and counting it would make the manifest
 *    promise an effect nobody would see. It also makes the count
 *    self-correcting across a resume: the second pass finds them already
 *    false and reports none.
 */
async function reviewerFlagsToClear(
  db: Firestore,
  round: Pick<AdmissionRoundDoc, "id" | "reviewerUids" | "finalDeciderUid">,
): Promise<string[]> {
  const named = [
    ...new Set([
      ...round.reviewerUids,
      ...(round.finalDeciderUid ? [round.finalDeciderUid] : []),
    ]),
  ];
  if (named.length === 0) return [];

  const roundsSnap = await db
    .collection(ROUNDS_COLLECTION)
    .select("reviewerUids", "finalDeciderUid")
    .get();
  const namedElsewhere = new Set<string>();
  for (const doc of roundsSnap.docs) {
    if (doc.id === round.id) continue;
    const data = doc.data() ?? {};
    const reviewers = data.reviewerUids;
    if (Array.isArray(reviewers)) {
      for (const uid of reviewers) if (typeof uid === "string") namedElsewhere.add(uid);
    }
    if (typeof data.finalDeciderUid === "string" && data.finalDeciderUid) {
      namedElsewhere.add(data.finalDeciderUid);
    }
  }

  const candidates = named.filter((uid) => !namedElsewhere.has(uid));
  if (candidates.length === 0) return [];

  const userDocs = await db.getAll(
    ...candidates.map((uid) => db.collection("users").doc(uid)),
  );
  return userDocs
    .filter((doc) => doc.exists && (doc.data() ?? {}).admissionsReviewer === true)
    .map((doc) => doc.id);
}

/**
 * Clear the flag on everyone the predicate names. Idempotent: a second run
 * finds them already false, names nobody, and writes nothing.
 */
async function clearReviewerFlags(
  db: Firestore,
  round: Pick<AdmissionRoundDoc, "id" | "reviewerUids" | "finalDeciderUid">,
): Promise<number> {
  const uids = await reviewerFlagsToClear(db, round);
  if (uids.length === 0) return 0;
  const batch = db.batch();
  for (const uid of uids) {
    batch.update(db.collection("users").doc(uid), { admissionsReviewer: false });
  }
  await batch.commit();
  return uids.length;
}

// ---------------------------------------------------------------------------
// Manifest counts + blockers
// ---------------------------------------------------------------------------

/**
 * Live counts of everything a round destroy would touch, read at request time
 * so the dialog shows what dies NOW rather than what a denormalised counter
 * last said. `applicationCounts` on the round is deliberately not used: it is
 * a counter maintained by the apply, submit and decide transactions, and this
 * is the last screen somebody reads before typing a name they cannot untype.
 *
 * Every query here is a single equality with no ordering, so all of them are
 * served by the automatic single-field indexes and nothing was added to
 * `firestore.indexes.json`.
 */
export async function countRoundDestroyTargets(
  db: Firestore,
  round: AdmissionRoundDoc,
): Promise<RoundDestroyCounts> {
  // The ids are read with a projection because they are needed twice: as the
  // application count, and as the only address the private rows have.
  const idSnap = await db
    .collection(APPLICATIONS_COLLECTION)
    .where("roundId", "==", round.id)
    .select()
    .get();
  const applicationIds = idSnap.docs.map((doc) => doc.id);

  const privateCounts = await Promise.all(
    chunk(applicationIds, APPLICATION_PAGE_SIZE).map(async (batch) => {
      const docs = await db.getAll(
        ...batch.map((id) => db.collection(APPLICATION_PRIVATE_COLLECTION).doc(id)),
      );
      return docs.filter((doc) => doc.exists).length;
    }),
  );

  const [reviews, stages, reviewerFlags, emailSendRows, dataExportRows] =
    await Promise.all([
      countAgg(db.collection(REVIEWS_COLLECTION).where("roundId", "==", round.id)),
      countAgg(
        db.collection(ROUNDS_COLLECTION).doc(round.id).collection(STAGES_SUBCOLLECTION),
      ),
      reviewerFlagsToClear(db, round).then((uids) => uids.length),
      // Admission mail logs `referenceId: roundId` (see admissionEmails.ts), so
      // this is "how much of the delivery log mentions this round". Retained.
      countAgg(db.collection("emailSends").where("referenceId", "==", round.id)),
      // An export row records what it covered in a `scope` map; a round-scoped
      // export writes `scope.roundId`. A nested key is an ordinary field to
      // Firestore and is auto-indexed like any other. Retained.
      countAgg(
        db.collection(DATA_EXPORTS_COLLECTION).where("scope.roundId", "==", round.id),
      ),
    ]);

  return {
    applications: applicationIds.length,
    applicationPrivateRows: privateCounts.reduce((a, b) => a + b, 0),
    reviews,
    stages,
    // One record per application, guaranteed before anything is deleted. The
    // destroy writes the entries that are missing, so the WRITES it makes can
    // be fewer; this is how many records must exist for it to proceed.
    memberRecordEntriesWritten: applicationIds.length,
    reviewerFlagsCleared: reviewerFlags,
    emailSendRows,
    dataExportRows,
  };
}

/**
 * The refuse-outright conditions, as sentences shown verbatim in the dialog.
 * Each names the state AND the way out, because destroy is never the first
 * tool: a round that is finished with should be cancelled or settled, and a
 * round that is merely in the way should be archived.
 *
 * Pure and synchronous (the status is the whole question), so the manifest
 * route and the cascade ask the same function and cannot disagree.
 *
 * A destroy pass already running is NOT a blocker here. It is a 409 from the
 * cascade with its own sentence, the same shape the run routes use: a
 * manifest that reported it as a blocker would hide the Resume button behind
 * a refusal the server would not actually make once the claim lapsed.
 */
export function roundDestroyBlockers(
  round: Pick<AdmissionRoundDoc, "status">,
): string[] {
  const blockers: string[] = [];
  if (round.status === "open") {
    blockers.push(
      "This round is open for applications. Close or settle the round first: destroying an intake somebody can still apply to would take an application away from them mid-sentence.",
    );
  }
  if (round.status === "deciding") {
    blockers.push(
      "This round is still being decided. Close or settle the round first, so the decisions are recorded on the people they are about before the applications go.",
    );
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// The audit row's own bookkeeping
// ---------------------------------------------------------------------------

/**
 * The fields this engine writes onto its own audit row on top of what
 * `destroyAudit.ts` puts there. All four are TOP-LEVEL fields and none of them
 * goes into the row's `deleted` map:
 *
 *  - `recordsWrittenAt`, the proof that the member-record sweep finished;
 *  - `memberRecordEntriesWritten`, how many records this destroy wrote;
 *  - `memberRecordEntriesAlreadyPresent`, how many were already on file and
 *    were deliberately left alone;
 *  - `reviewerFlagsCleared`, how many people's Admissions nav flag was turned
 *    off.
 *
 * THE `deleted` MAP IS DELETIONS ONLY, and keeping these out of it is a
 * correctness rule rather than tidiness. `destroyAudit.ts` documents that map
 * as per-collection deletion counts and calls the row the only surviving
 * evidence of a destroy, and the dialog renders every key of it under "and the
 * records listed below no longer exist". Put "member record entries written" in
 * there and both the audit log and the receipt end up asserting that the thing
 * the destroy exists to preserve has been destroyed.
 *
 * They live here rather than in the shared module because they are properties
 * of THIS cascade rather than of an audit. The shared row records what a
 * destroy removed; whether the records were written first is the round
 * cascade's own precondition, and the circulation cascade beside it has no
 * equivalent.
 *
 * `set(..., { merge: true })` with a plain number rather than `increment`,
 * because the sweep runs at most once per destroy and a resume that re-runs it
 * (a pass that died inside the sweep, so the stamp was never written) has to
 * REPLACE the half-finished count rather than add to it.
 *
 * A resume that finds the stamp skips the sweep, which is what keeps
 * `memberRecordEntriesWritten` an exact count rather than a sum over
 * overlapping rewrites: the records are written for EVERY application on the
 * round before anything is deleted, so the applications a resume still finds
 * are a subset of ones already recorded. A pass that died inside the sweep
 * never wrote the stamp, so the resume runs the sweep again.
 *
 * The lease that keeps two passes off one row is the shared
 * `claimDestroyAuditPass` / `releaseDestroyAuditPass` pair, so every destroy
 * in the codebase contends the same way.
 *
 * THE RESIDUAL RACE, stated rather than hidden: two admins pressing Destroy
 * on the same round in the same instant, on two Cloud Run instances, can both
 * find no interrupted row and both open one. The claim then keeps each pass
 * out of the other's row, so the cost is a second line in the audit log
 * rather than a lost or doubled count. The `destroying` marker this cascade
 * writes on the round is NOT that guard: it is written after the record sweep
 * rather than in the audit row's own transaction, and it exists to stop the
 * round being reopened to applicants while it is half gone, which is a
 * different failure entirely.
 */
async function stampRecordWrites(
  db: Firestore,
  auditId: string,
  counts: { written: number; alreadyPresent: number },
  { finished }: { finished: boolean },
): Promise<void> {
  await db
    .collection(DESTROY_AUDITS_COLLECTION)
    .doc(auditId)
    .set(
      {
        memberRecordEntriesWritten: counts.written,
        memberRecordEntriesAlreadyPresent: counts.alreadyPresent,
        // Only a sweep that reached the end stamps this, because the stamp is
        // what a resume reads to decide it can skip the sweep.
        ...(finished ? { recordsWrittenAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true },
    );
}

/** The reviewer-flag total, on the row and outside the `deleted` map. */
async function stampReviewerFlagsCleared(
  db: Firestore,
  auditId: string,
  cleared: number,
): Promise<void> {
  await db
    .collection(DESTROY_AUDITS_COLLECTION)
    .doc(auditId)
    .set({ reviewerFlagsCleared: cleared }, { merge: true });
}

/** Non-negative integers only, from a row that a resume is reading back. */
function count(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0;
}

type RecordSweepState = {
  /** Has the member-record sweep already finished for this destroy? */
  done: boolean;
  written: number;
  alreadyPresent: number;
  reviewerFlagsCleared: number;
};

/**
 * The row's own non-deletion fields, read once per pass.
 *
 * A resume needs them for two reasons: to decide whether the record sweep still
 * has to run, and to report the whole destroy's non-deletion totals rather than
 * this pass's (a resume can be driven from a tab that never saw the first pass,
 * exactly as with the `deleted` map).
 */
async function readRecordSweepState(
  db: Firestore,
  auditId: string,
): Promise<RecordSweepState> {
  const snap = await db.collection(DESTROY_AUDITS_COLLECTION).doc(auditId).get();
  const raw = snap.data() ?? {};
  return {
    done: Boolean(raw.recordsWrittenAt),
    written: count(raw.memberRecordEntriesWritten),
    alreadyPresent: count(raw.memberRecordEntriesAlreadyPresent),
    reviewerFlagsCleared: count(raw.reviewerFlagsCleared),
  };
}

/** Only the keys that moved, so an untouched stage writes nothing. */
function nonZero(totals: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(totals)) if (value > 0) out[key] = value;
  return out;
}

/**
 * The non-deletion totals, as the result reports them.
 *
 * Every key is present even at zero, unlike the `deleted` map: "0 member record
 * entries written" is the normal and reassuring outcome of destroying a round
 * that settled (they were all already on file), and a key that vanished at zero
 * would leave a reader unable to tell that from a sweep that never ran.
 */
function writeTotals(sweep: RecordSweepState): Record<string, number> {
  return {
    memberRecordEntriesWritten: sweep.written,
    memberRecordEntriesAlreadyPresent: sweep.alreadyPresent,
    reviewerFlagsCleared: sweep.reviewerFlagsCleared,
  };
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/**
 * Destroy one admission round. Admin-only (enforced at the route), resumable
 * by repeating the identical call.
 *
 * ORDER OF OPERATIONS, each step with the reason it sits where it does:
 *
 *  0. Blockers, on a FRESH destroy only, then the audit row. Audit first is
 *     the crash-safety property: from that write onward an open row exists
 *     for anything that dies.
 *  1. THE MEMBER RECORDS, before a single delete, refusing the whole destroy
 *     if any of them failed. See the module comment.
 *  2. THE `destroying` MARKER on the round, after the records are safe and
 *     before the first delete, so a round that is half destroyed between
 *     passes cannot be reopened to applicants. Also see the module comment.
 *  3. Reviews. They are written ABOUT the applications, so they go first: a
 *     review whose application is gone names nothing, and the review rows are
 *     the only place a reviewer's notes live until step 1 has copied them.
 *  4. Applications, each with its access-requirements row in the SAME batch.
 *     See `drainApplications` for why the pairing is not negotiable.
 *  5. Stages, the round's question blocks. After the applications, because an
 *     answer is keyed by the stage it was given in and the stage text is what
 *     makes a surviving answer legible.
 *  6. The reviewer nav flags, while the round document still exists, so the
 *     "named on another round" predicate can exclude this one by id.
 *  7. The round document LAST, then the audit row's completion stamp. While
 *     the round exists a resumed cascade can still find everything by name;
 *     deleting it is the write that makes the destroy final.
 *
 * The drain loop runs FULL PASSES until a pass deletes nothing. Pass one does
 * the work and the mandatory zero-delete pass is the verification: nothing
 * client-side can write any of these collections (`admissionApplications`,
 * `admissionReviews` and the stages are all `allow read, write: if false`), so
 * a pass that finds them empty is a pass that found them permanently empty.
 *
 * THE ROUND MUST STILL EXIST. There is no finishing mode for a cascade whose
 * round document has already gone: the route reads the round first and answers
 * 404 without ever calling this, and a mode nothing can reach is a mode nothing
 * tests. The window it would have covered is between the round delete in step 7
 * and the completion stamp on the line after it, and what it leaves behind is an
 * audit row with no `completedAt` on a round id that no longer resolves. That
 * row is a cosmetic wart in the destroy log rather than a hazard: everything is
 * already deleted, round ids carry a random suffix so a later round cannot
 * inherit it, and no surface reads an open row for a round that is not there.
 */
export async function destroyRoundCascade(
  db: Firestore,
  roundId: string,
  round: AdmissionRoundDoc,
  actor: DestroyActor,
): Promise<RoundDestroyResult> {
  const interrupted = await readInterruptedDestroyAudit(db, AUDIT_KIND, roundId);

  // Blockers on a FRESH destroy only. A resume must never be re-blocked, or an
  // interrupted cascade wedges on a state its own first pass created.
  if (!interrupted) {
    const blockers = roundDestroyBlockers(round);
    if (blockers.length > 0) throw new RoundDestroyBlockedError(blockers);
  }

  const auditId =
    interrupted?.auditId ??
    (await openDestroyAudit(db, {
      kind: AUDIT_KIND,
      targetId: roundId,
      label: round.label,
      actorUid: actor.actorUid,
      actorName: actor.actorName,
    }));

  // The shared claim, so a second invocation arriving mid-pass is refused
  // (`DestroyPassInFlightError` → 409) rather than allowed to count the same
  // pages into the same row twice. `first` on a freshly opened row, so the
  // pass that started the destroy is not recorded as a resume.
  await claimDestroyAuditPass(db, auditId, { first: interrupted === null });

  const totals: Record<string, number> = {};
  const budget: Budget = { remaining: DESTROY_DOC_BUDGET };
  // A row this call just opened has nothing on it to read back, so only a
  // RESUME pays for the read.
  let sweep: RecordSweepState =
    interrupted === null
      ? { done: false, written: 0, alreadyPresent: 0, reviewerFlagsCleared: 0 }
      : await readRecordSweepState(db, auditId);

  try {
    // ---- 1. The member records, before anything is deleted ----------------
    if (!sweep.done) {
      const sync = await writeRecordsForRound(db, round, "destroy", actor.actorUid);
      if (sync.failed.length > 0) {
        // The partial totals are stamped WITHOUT `recordsWrittenAt`, so the row
        // says how far the refused attempt got and a later attempt still runs
        // the sweep again.
        await stampRecordWrites(db, auditId, sync, { finished: false });
        // A refusal, and NOTHING has been deleted, so this attempt is
        // FINISHED rather than interrupted. The row is closed for two
        // reasons, and the second is the one that matters: an open row is
        // read as a destroy to resume, which suppresses the blockers (a
        // resume must never be re-blocked). Leaving it open would mean a
        // round reopened after a failed attempt could then be destroyed
        // while it was live. Closing it costs nothing, because there is no
        // progress to carry: the entries that did land are the ones a later
        // attempt would have skipped anyway.
        await completeDestroyAudit(db, auditId);
        throw new MemberRecordWriteError(sync.failed);
      }
      // Stamped only after every record landed, so a sweep that died part-way
      // is a sweep the resume runs again.
      await stampRecordWrites(db, auditId, sync, { finished: true });
      sweep = {
        done: true,
        written: sync.written,
        alreadyPresent: sync.alreadyPresent,
        reviewerFlagsCleared: sweep.reviewerFlagsCleared,
      };
    }

    // ---- 2. The marker, after the records and before the first delete ------
    // Written every pass rather than once: it is a two-field merge onto a
    // document that is about to be deleted anyway, and paying for it each pass
    // is cheaper than a read to find out whether it is already there.
    await db
      .collection(ROUNDS_COLLECTION)
      .doc(roundId)
      .update({ destroying: true, destroyAuditId: auditId });

    // ---- 3-5. The drain ---------------------------------------------------
    const stages: { key: string; drain: () => Promise<DrainResult> }[] = [
      {
        key: "reviews",
        drain: () =>
          drainQuery(
            db,
            REVIEWS_COLLECTION,
            () => db.collection(REVIEWS_COLLECTION).where("roundId", "==", roundId),
            budget,
          ),
      },
      {
        key: "applications",
        drain: () => drainApplications(db, roundId, budget, totals),
      },
      {
        key: "stages",
        drain: () =>
          drainQuery(
            db,
            STAGES_SUBCOLLECTION,
            () =>
              db
                .collection(ROUNDS_COLLECTION)
                .doc(roundId)
                .collection(STAGES_SUBCOLLECTION),
            budget,
          ),
      },
    ];

    let complete = false;
    for (let pass = 1; ; pass += 1) {
      if (pass > MAX_PASSES) {
        throw new Error(
          `admissionsDestroy: round ${roundId} still producing rows after ${MAX_PASSES} full passes, aborting`,
        );
      }
      let passDeleted = 0;
      let allDrained = true;
      for (const stage of stages) {
        if (budget.remaining <= 0) {
          allDrained = false;
          break;
        }
        const result = await stage.drain();
        totals[stage.key] = (totals[stage.key] ?? 0) + result.deleted;
        passDeleted += result.deleted;
        if (!result.drained) allDrained = false;
      }
      // A stage reports un-drained only when the budget ran out: a stage that
      // stops making progress throws inside the drain rather than returning.
      if (!allDrained) break;
      if (passDeleted === 0) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      await accumulateDestroyAudit(db, auditId, nonZero(totals));
      await releaseDestroyAuditPass(db, auditId);
      return {
        auditId,
        deleted: await readDestroyAuditTotals(db, auditId, totals),
        writes: writeTotals(sweep),
        complete: false,
        resumed: interrupted !== null,
      };
    }

    // ---- 6. The nav flags, while the round is still readable --------------
    // The count lands on the audit row as its own field rather than in
    // `totals`, which is the map that becomes `deleted`. Turning a boolean off
    // on somebody's user document is not a row this destroy removed.
    const flagsCleared = await clearReviewerFlags(db, round);
    await stampReviewerFlagsCleared(db, auditId, flagsCleared);
    sweep = { ...sweep, reviewerFlagsCleared: flagsCleared };

    // ---- 7. The round document, then the completion stamp -----------------
    await db.collection(ROUNDS_COLLECTION).doc(roundId).delete();
    totals.round = 1;
    await accumulateDestroyAudit(db, auditId, nonZero(totals));
    // Stamps `completedAt` and hands the claim back in the same write, so a
    // finished row never holds a lease over a target somebody recreates.
    await completeDestroyAudit(db, auditId);

    return {
      auditId,
      deleted: await readDestroyAuditTotals(db, auditId, totals),
      writes: writeTotals(sweep),
      complete: true,
      resumed: interrupted !== null,
    };
  } catch (err) {
    // Best-effort, and it swallows its own failure: the interesting error is
    // the one already being thrown, and an unreleased claim lapses on its
    // own. A process killed outright never gets here at all, which is the
    // window the shared lease documents.
    await releaseDestroyAuditPass(db, auditId);
    throw err;
  }
}

/**
 * The interrupted report for one round, as the manifest route hands it to the
 * client. A thin pass-through so every surface asks the same question of the
 * same collection, and so the route does not have to know the audit kind
 * string.
 */
export async function readInterruptedRoundDestroy(db: Firestore, roundId: string) {
  return readInterruptedDestroyAudit(db, AUDIT_KIND, roundId);
}
