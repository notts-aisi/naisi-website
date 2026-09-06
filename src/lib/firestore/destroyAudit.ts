import "server-only";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";

/**
 * `destroyAudits/{autoId}`: one row per destroy attempt, for every cascade
 * that is NOT a course.
 *
 * ## What it is
 *
 * The audit half of `courseDeletion.ts`, lifted out and made generic. A row is
 * opened BEFORE the first delete, accumulates per-collection counts as the
 * cascade drains, and is stamped `completedAt` when the cascade finishes. So a
 * row with `completedAt: null` is durable evidence of an INTERRUPTED destroy,
 * which is the property the whole design is for: the rows a destroy removes
 * are gone, so if the cascade dies half way there is nothing else left to say
 * it ever ran, what it was told to remove, or how far it got.
 *
 * That is the same argument the impersonation log and `accountDeletion`'s
 * keep-the-tracker-row rule make. It is worth restating because the tempting
 * simplification (write the row at the END, when the counts are known) turns
 * every crash into an untracked deletion.
 *
 * ## Why a SECOND collection rather than a `kind` field on `courseDeletions`
 *
 * The obvious move is to widen the existing one. It is the wrong move, and the
 * reason is not tidiness:
 *
 *  - `courseDeletions` is only half of that protocol. The other half is a
 *    MARKER stamped on the course or run document itself (`destroying: true`,
 *    `destroyAuditId`), written in the same transaction as the row, and the
 *    pass LEASE that stops two invocations double-counting is read through
 *    that marker. Both halves live on the courses documents. A circulation, a
 *    worksheet and an admission round have no such field and no reason to grow
 *    one, so reusing the collection would mean either bolting a marker field
 *    onto three unrelated documents or maintaining two different resume
 *    mechanisms behind one collection name.
 *  - `readInterruptedDestroy` in `courseDeletion.ts` is a single `get()`
 *    precisely BECAUSE the marker names its row. Without a marker the same
 *    question is a query, which is what `readInterruptedDestroyAudit` below
 *    is, and a query with different index needs from the get it would be
 *    sharing a collection with.
 *  - The two collections' rules and cascades are already independent: a course
 *    destroy drains `courseAudit` rows for its run, and nothing here should be
 *    reachable by that cascade or by any other.
 *
 * So the course engine keeps `courseDeletions` and this file keeps
 * `destroyAudits`. Both are `allow read: if isAdmin()` and `allow write: if
 * false`, and neither is swept by account deletion.
 *
 * ## The resume shape this supports
 *
 * There is no marker, so a resume is found by asking the collection: the
 * newest row for this (kind, targetId) with no `completedAt`. A cascade built
 * on this module therefore:
 *
 *  1. calls `readInterruptedDestroyAudit` and resumes into the row it names,
 *     or `openDestroyAudit` when there is none;
 *  2. calls `accumulateDestroyAudit` as it drains, so the totals survive a
 *     pass that runs out of budget;
 *  3. calls `completeDestroyAudit` when the last page is gone.
 *
 * The counts are the ACCUMULATED totals of the whole destroy rather than one
 * pass's own, for the reason `courseDeletion.ts` argues at length: a resume can
 * begin in a different browser tab from the one that started the cascade, and
 * only the server can state what the whole destroy has removed.
 *
 * ## Rows are keys, never user data
 *
 * `accumulateDestroyAudit` writes each count at the dotted path
 * `deleted.<key>`, which is a deliberate nested-map update. The keys are the
 * cascade's own fixed stage identifiers (`responses`, `reviews`, `tasks`), so
 * the dotted path is safe here in a way it would not be for a map keyed by
 * anything a person supplied: a key containing a dot would silently write a
 * nested field. Do not pass a key that came from a document.
 */

export const DESTROY_AUDITS_COLLECTION = "destroyAudits";

/**
 * Which cascade opened the row. One member per destroy protocol that is not a
 * course, and the query axis of the interrupted probe alongside `targetId`.
 *
 * `worksheet` IS RESERVED AND NOTHING WRITES IT YET. Say that plainly, because
 * the opposite assumption is the dangerous one: deleting a library worksheet
 * (`DELETE /api/worksheets/{worksheetId}`) removes the document and its images
 * in a single pass and opens no row here, so THE ABSENCE OF A `worksheet` ROW
 * IS NOT EVIDENCE THAT NOBODY DELETED A WORKSHEET. It is the one deletion in
 * this wave with no manifest, no resume and no audit, on the grounds that it is
 * a single confirm over a document whose circulations each carry their own copy
 * of the items, so nothing anybody was answering goes with it.
 *
 * The member stays in the union because the argument for recording it is a good
 * one ("who deleted the worksheet everyone was circulating" deserves an answer
 * that is not a guess) and the change is small: open a row before
 * `deleteWorksheetDocument` and complete it after, with no lease, because a
 * worksheet delete is one pass by construction. Whoever makes that change owns
 * this paragraph and the matching sentences in `firestore.rules` and
 * `docs/worksheets.md`.
 */
export type DestroyAuditKind = "circulation" | "worksheet" | "admission-round";

export const DESTROY_AUDIT_KINDS: DestroyAuditKind[] = [
  "circulation",
  "worksheet",
  "admission-round",
];

export const DESTROY_AUDIT_LIMITS = {
  /** The target's human name, as the confirmation dialog spelled it. */
  label: 200,
  actorName: 120,
} as const;

/**
 * An earlier destroy of this target that never reached `completedAt`, as the
 * manifest routes report it.
 *
 * This is what turns a crashed cascade from console archaeology into a banner
 * with a Resume button, so the fields are the ones that banner needs and
 * nothing else. `startedAt` is ISO 8601 because the wire has no Timestamp and
 * the client re-zones nothing; `startedByName` is a display name and never an
 * address, because the row is deliberately PII-light.
 */
export type InterruptedDestroyAudit = {
  auditId: string;
  startedAt: string | null;
  startedByName: string | null;
  /** What that attempt had already removed when it stopped. */
  deleted: Record<string, number>;
};

/**
 * Thrown when another invocation already holds this row's pass claim. Routes
 * map it to 409 with the sentence intact.
 *
 * NOT a failure: the destroy is running, and the honest answer to "run another
 * pass" is "one is already running" rather than a second cascade counting the
 * same pages into the same row twice.
 */
export class DestroyPassInFlightError extends Error {
  readonly auditId: string;
  /** When the current claim lapses: the earliest a retry can succeed. */
  readonly until: Date;
  constructor(auditId: string, until: Date) {
    super(
      "A destroy pass is already running for this. Wait for it to finish and then resume, because starting a second pass now would count the same rows twice.",
    );
    this.name = "DestroyPassInFlightError";
    this.auditId = auditId;
    this.until = until;
  }
}

/**
 * How long one invocation's claim on a row lasts. Comfortably longer than a
 * pass (Cloud Run caps a request at 60 seconds) and short enough that a pass
 * killed mid-flight does not strand the resume for long. A process that DIES
 * leaves its claim standing until it expires, so a resume can be up to this
 * far away; that window is the deliberate cost of exact totals.
 */
export const DESTROY_PASS_LEASE_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Coercions
// ---------------------------------------------------------------------------

/** Non-negative integers only, from a row's `deleted` map. */
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

function toDate(v: unknown): Date | null {
  const obj = v as { toDate?: () => Date } | null | undefined;
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * Open a row, BEFORE anything dies. Returns its id.
 *
 * `startedAt` is a server timestamp, `completedAt` is an explicit null (not an
 * absent field), and `deleted` is an explicit empty map. All three are written
 * out rather than left to appear later because the interrupted probe reads
 * them: a row whose `completedAt` key is simply missing and a row whose destroy
 * has not finished have to be the same thing, and they are only the same thing
 * if every row is written the same way.
 *
 * `label` is the target's human name AS THE CONFIRMATION DIALOG SPELLED IT.
 * That is the point of storing it: once the cascade has run, the id names
 * nothing and the label is the only thing that says what was destroyed.
 */
export async function openDestroyAudit(
  db: Firestore,
  input: {
    kind: DestroyAuditKind;
    targetId: string;
    label: string;
    actorUid: string;
    actorName: string;
  },
): Promise<string> {
  const ref = db.collection(DESTROY_AUDITS_COLLECTION).doc();
  await ref.set({
    kind: input.kind,
    targetId: input.targetId,
    label: str(input.label, DESTROY_AUDIT_LIMITS.label),
    startedAt: FieldValue.serverTimestamp(),
    startedByUid: input.actorUid,
    startedByName: str(input.actorName, DESTROY_AUDIT_LIMITS.actorName),
    deleted: {},
    completedAt: null,
    resumeCount: 0,
    passInFlightUntil: null,
  });
  return ref.id;
}

/**
 * Add this pass's per-collection counts to the row.
 *
 * `FieldValue.increment` per key rather than a read-modify-write, so two
 * updates cannot lose each other and a resume adds to the totals rather than
 * replacing them. A count of zero is skipped: a stage that removed nothing this
 * pass should not create a `deleted.thing: 0` key that reads, on the completed
 * row, as "we looked and there were none" when in fact the stage never ran.
 */
export async function accumulateDestroyAudit(
  db: Firestore,
  auditId: string,
  counts: Record<string, number>,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const [key, n] of Object.entries(counts)) {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      patch[`deleted.${key}`] = FieldValue.increment(Math.floor(n));
    }
  }
  if (Object.keys(patch).length === 0) return;
  await db.collection(DESTROY_AUDITS_COLLECTION).doc(auditId).update(patch);
}

/**
 * Stamp the row finished, and hand back its pass claim in the same write.
 *
 * The two go together on purpose: a row stamped complete while still holding a
 * claim would refuse a later destroy of a target that has been recreated under
 * the same id, for up to the lease window, with a message about a pass that
 * finished.
 *
 * IT DOES NOT CHECK THAT THE CALLER STILL HOLDS THE CLAIM, which is worth
 * naming because it looks like an oversight. Both cascades call this only from
 * the pass that drained the last page, under a claim they took at the top of
 * that same pass, so the case it would guard against (a straggler stamping a
 * row complete under a pass that is still running) is unreachable today. A
 * third cascade that completes a row from anywhere other than its own finishing
 * pass has to make this a transaction that verifies `passInFlightUntil` first.
 */
export async function completeDestroyAudit(db: Firestore, auditId: string): Promise<void> {
  await db.collection(DESTROY_AUDITS_COLLECTION).doc(auditId).update({
    completedAt: FieldValue.serverTimestamp(),
    passInFlightUntil: null,
  });
}

/**
 * The row's ACCUMULATED `deleted` map, read back after a pass's increments have
 * landed. This is what a cascade reports to the client as its running total.
 *
 * A failed read-back returns the fallback rather than throwing: by the time it
 * runs the deletions are done, and on the completing pass the target document
 * is already gone, so throwing here would report a failure for a destroy that
 * finished and send the client into a resume that can no longer find anything.
 */
export async function readDestroyAuditTotals(
  db: Firestore,
  auditId: string,
  fallback: Record<string, number>,
): Promise<Record<string, number>> {
  try {
    const snap = await db.collection(DESTROY_AUDITS_COLLECTION).doc(auditId).get();
    return auditDeletedTotals((snap.data() ?? {}).deleted);
  } catch (err) {
    console.error(
      "[destroyAudit] could not read back the totals, reporting this pass's own counts:",
      auditId,
      err,
    );
    return fallback;
  }
}

/**
 * The interrupted destroy of this target, or null when there is not one.
 *
 * THE QUERY IS EQUALITY-ONLY AND HAS NO `orderBy`, so it is served by the
 * automatic single-field indexes and `firestore.indexes.json` owes it nothing.
 * That is a deliberate constraint rather than an accident: the obvious form of
 * this question (`where completedAt == null` plus `orderBy startedAt desc`)
 * needs a composite index, and an index that has not finished building fails
 * the query outright, which here would mean a destroy silently starting a
 * SECOND row over a cascade that is half done. Picking the newest row in code
 * costs one small read and cannot fail that way.
 *
 * The read is unbounded on purpose too. One row exists per time somebody
 * pressed Destroy on this exact target, a destroy is a rare admin act, and the
 * completing row for a successful destroy names a target that no longer exists,
 * so the set stays in single figures. A `limit` with no `orderBy` would return
 * an arbitrary page and could miss the very row this is looking for.
 *
 * There is therefore NO UPPER BOUND on this read, and the honest thing is to
 * write down the threshold rather than pretend one exists. The only way the set
 * grows is a target destroyed, recreated under the same id and destroyed again,
 * over and over. If a (kind, targetId) pair ever holds more than about fifty
 * rows, this query is the wrong shape and the fix is a marker field on the
 * target document (which is what `courseDeletion.ts` has, and what turns this
 * question back into a single `get`), not a `limit` bolted onto a query with no
 * order.
 *
 * A row with a null `startedAt` (the server timestamp has not resolved yet on a
 * just-written row) sorts LAST rather than first, so a freshly opened row can
 * never displace the interrupted one this is looking for.
 */
export async function readInterruptedDestroyAudit(
  db: Firestore,
  kind: DestroyAuditKind,
  targetId: string,
): Promise<InterruptedDestroyAudit | null> {
  const snap = await db
    .collection(DESTROY_AUDITS_COLLECTION)
    .where("kind", "==", kind)
    .where("targetId", "==", targetId)
    .get();

  const open = snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() ?? {} }))
    .filter((row) => !row.data.completedAt)
    .sort((a, b) => {
      const at = toDate(a.data.startedAt)?.getTime() ?? 0;
      const bt = toDate(b.data.startedAt)?.getTime() ?? 0;
      return bt - at;
    });

  const newest = open[0];
  if (!newest) return null;

  const startedByName = str(newest.data.startedByName, DESTROY_AUDIT_LIMITS.actorName);
  return {
    auditId: newest.id,
    startedAt: toDate(newest.data.startedAt)?.toISOString() ?? null,
    startedByName: startedByName || null,
    deleted: auditDeletedTotals(newest.data.deleted),
  };
}

// ---------------------------------------------------------------------------
// The pass claim
// ---------------------------------------------------------------------------

/**
 * Claim the row for this pass, refusing when another invocation still holds it.
 *
 * WHY THIS LIVES HERE rather than in each cascade. The claim is a field on the
 * audit row, and the row is this module's. Three cascades hand-rolling a lease
 * on a document none of them owns is three chances to write the field with a
 * different name, a different unit or a different expiry rule, and the failure
 * that follows is silent: two passes both increment the same counters over the
 * same pages, and the receipt the admin reads is simply wrong.
 *
 * A TRANSACTION rather than a conditional update, because the case this exists
 * for is two admins pressing Destroy at the same moment, which is exactly when
 * a read followed by a write is two operations with a gap in the middle.
 *
 * This is contention protection, not distributed locking. The claim is released
 * at the end of a pass (`releaseDestroyAuditPass`, and `completeDestroyAudit`
 * on the finishing one), and a process that dies leaves it standing until it
 * expires.
 *
 * `resumeCount` is bumped here rather than by the caller, so the row counts
 * passes even when a cascade forgets to say it resumed.
 */
export async function claimDestroyAuditPass(
  db: Firestore,
  auditId: string,
  { first = false }: { first?: boolean } = {},
): Promise<void> {
  const ref = db.collection(DESTROY_AUDITS_COLLECTION).doc(auditId);
  const leaseUntil = Timestamp.fromMillis(Date.now() + DESTROY_PASS_LEASE_MS);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      throw new Error(`destroyAudit: ${auditId} does not exist, so it cannot be claimed`);
    }
    const raw = snap.data() ?? {};
    const lease = raw.passInFlightUntil as { toMillis?: () => number } | null | undefined;
    const until = typeof lease?.toMillis === "function" ? lease.toMillis() : 0;
    if (until > Date.now()) throw new DestroyPassInFlightError(auditId, new Date(until));
    txn.update(ref, {
      passInFlightUntil: leaseUntil,
      // The pass that OPENED the row is pass zero, not a resume. Only the
      // caller knows which it is, so it says so.
      ...(first ? {} : { resumeCount: FieldValue.increment(1) }),
    });
  });
}

/**
 * Hand the claim back on the way out of a pass that is not the last one.
 *
 * Best-effort by design: it runs in the cascade's `finally`, where the
 * interesting error is the one already being thrown, and a failure to release
 * costs at most one lease window before the claim expires on its own.
 */
export async function releaseDestroyAuditPass(
  db: Firestore,
  auditId: string,
): Promise<void> {
  try {
    await db
      .collection(DESTROY_AUDITS_COLLECTION)
      .doc(auditId)
      .update({ passInFlightUntil: null });
  } catch (err) {
    console.error("[destroyAudit] could not release the pass claim:", auditId, err);
  }
}
