import "server-only";

/**
 * Claim-before-send against `schedulerMarkers`.
 *
 * The id builders and the pure re-claim decision live in
 * `src/lib/firestore/schedulerMarkers.ts` (and are re-exported here so a job
 * handler needs one import); this module is the thin Firestore layer over
 * them. Read that module's header first: it explains WHY a claimed-but-
 * unsent marker has to be reclaimable, which is the only interesting thing
 * about this file.
 *
 * THE ORDER MATTERS AND IS NOT NEGOTIABLE:
 *
 *   1. `claim()`, which `.create()`s the marker. ALREADY_EXISTS means somebody
 *      else has this unit of work; stop.
 *   2. do the side effect (send the mail, mint the task)
 *   3. `stampSent()`, which writes `sentAt`.
 *
 * Claim first, send second. The reverse order (send, then mark) turns any
 * crash into a duplicate send, and duplicates are the failure mode people
 * complain about publicly. This order turns a crash into a MISSED send
 * instead, which is why step 3 has a recovery rule and step 1 does not.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  DEFAULT_MARKER_POLICY,
  SCHEDULER_MARKERS_COLLECTION,
  decideMarkerClaim,
  normalizeSchedulerMarker,
  schedulerMarkerExpiry,
  type MarkerPolicy,
  type SchedulerMarker,
  type SchedulerMarkerRef,
} from "@/lib/firestore/schedulerMarkers";

export {
  DEFAULT_MARKER_POLICY,
  MARKER_FAMILIES,
  SCHEDULER_MARKERS_COLLECTION,
  SCHEDULER_MARKER_RETENTION_DAYS,
  breakReturnMarker,
  decideMarkerClaim,
  isStaleWork,
  markerFamilyOf,
  normalizeSchedulerMarker,
  reminderMarker,
  schedulerMarkerExpiry,
  stageRecipientMarker,
  stageReleaseMarker,
  unmarkedRegisterMarker,
} from "@/lib/firestore/schedulerMarkers";
export type {
  MarkerDecision,
  MarkerPolicy,
  SchedulerMarker,
  SchedulerMarkerFamily,
  SchedulerMarkerRef,
} from "@/lib/firestore/schedulerMarkers";

/** Firestore's code for "this doc id is taken". */
const ALREADY_EXISTS = 6;

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === ALREADY_EXISTS || code === "already-exists";
}

/** Trim a thrown value to something safe to store on the marker. */
export function errorText(err: unknown, max = 300): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  return raw.slice(0, max);
}

export type ClaimOutcome =
  | { claimed: true; attempts: number; reclaimed: boolean }
  | {
      claimed: false;
      reason: "sent" | "failed" | "skipped" | "in-flight" | "raced" | "gave-up";
    };

/**
 * Try to take ownership of one unit of work.
 *
 * Fresh work takes the `.create()` path, which is atomic: two ticks racing on
 * the same id produce exactly one winner and one ALREADY_EXISTS, with no
 * transaction. Recovery of a stuck marker cannot use `.create()` (the doc is
 * there), so it re-claims inside a transaction that re-reads the marker and
 * re-runs the same decision. Otherwise two ticks that both saw a stale
 * marker would both send.
 */
export async function claim(
  db: Firestore,
  ref: SchedulerMarkerRef,
  meta: { job: string; policy?: MarkerPolicy },
): Promise<ClaimOutcome> {
  const policy = meta.policy ?? DEFAULT_MARKER_POLICY;
  const docRef = db.collection(SCHEDULER_MARKERS_COLLECTION).doc(ref.id);

  // Fast path: nothing there yet.
  try {
    await docRef.create({
      job: meta.job,
      family: ref.family,
      ...ref.fields,
      claimedAt: FieldValue.serverTimestamp(),
      attempts: 1,
      sentAt: null,
      failedAt: null,
      skippedReason: null,
      lastError: null,
    });
    return { claimed: true, attempts: 1, reclaimed: false };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }

  // Slow path: a marker exists. Decide inside a transaction so the decision
  // and the write it authorises cannot be split by a competing tick.
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const existing: SchedulerMarker | null = snap.exists
      ? normalizeSchedulerMarker(ref.id, snap.data() as Record<string, unknown>)
      : null;
    const decision = decideMarkerClaim(existing, new Date(), policy);

    if (decision.action === "skip") {
      return { claimed: false, reason: decision.reason } as ClaimOutcome;
    }
    if (decision.action === "give-up") {
      tx.set(
        docRef,
        {
          failedAt: FieldValue.serverTimestamp(),
          lastError:
            existing?.lastError ??
            `Gave up after ${decision.attempts} claims with no send.`,
        },
        { merge: true },
      );
      return { claimed: false, reason: "gave-up" } as ClaimOutcome;
    }

    tx.set(
      docRef,
      {
        job: meta.job,
        family: ref.family,
        ...ref.fields,
        claimedAt: FieldValue.serverTimestamp(),
        attempts: decision.attempts,
        sentAt: null,
        failedAt: null,
        skippedReason: null,
      },
      { merge: true },
    );
    return {
      claimed: true,
      attempts: decision.attempts,
      reclaimed: decision.reclaimed,
    } as ClaimOutcome;
  });
}

/**
 * Step 3: the side effect succeeded.
 *
 * This is also where the marker's retention clock starts. A settled marker
 * describes history and gets an `expiresAt`; one still in flight, or one
 * stamped `failedAt` and waiting for an admin, deliberately does not.
 */
export async function stampSent(
  db: Firestore,
  markerId: string,
  sentAt: Date = new Date(),
): Promise<void> {
  await db
    .collection(SCHEDULER_MARKERS_COLLECTION)
    .doc(markerId)
    .set(
      { sentAt, lastError: null, expiresAt: schedulerMarkerExpiry(sentAt) },
      { merge: true },
    );
}

/**
 * The side effect threw. Record why and leave `sentAt` null so the re-claim
 * rule can pick it up on a later tick. This is NOT a terminal state.
 */
export async function stampError(
  db: Firestore,
  markerId: string,
  err: unknown,
): Promise<void> {
  await db
    .collection(SCHEDULER_MARKERS_COLLECTION)
    .doc(markerId)
    .set({ lastError: errorText(err) }, { merge: true });
}

/**
 * The work was found but consciously not done: too late to be worth doing,
 * audience gone, run cancelled. Terminal, and distinct from a failure: a
 * skipped marker never gets a Retry button, because retrying is not what an
 * admin wants.
 */
export async function stampSkipped(
  db: Firestore,
  markerId: string,
  reason: string,
  at: Date = new Date(),
): Promise<void> {
  await db
    .collection(SCHEDULER_MARKERS_COLLECTION)
    .doc(markerId)
    .set(
      {
        skippedReason: reason.slice(0, 200),
        // Settled, so the retention clock starts here too.
        expiresAt: schedulerMarkerExpiry(at),
      },
      { merge: true },
    );
}

/**
 * Write a marker that is SETTLED THE MOMENT IT IS WRITTEN, and claim nothing.
 *
 * The claim / stamp pair exists to protect a side effect: it hands one tick
 * the right to do a thing, and it counts the attempts so an unattended loop
 * cannot run forever. A verdict with no side effect behind it needs neither.
 * A stage the clock has already ruled too late to announce is exactly that:
 * the job re-derives the same answer on every tick, nobody is mailed either
 * way, and putting it through `claim()` would spend one of the unit's three
 * attempts to record an opinion.
 *
 * So this is one `.create()` of an already-terminal document. Returns false
 * when a marker is already there, which is the normal case from the second
 * tick onwards and is not an error: the verdict was recorded the first time.
 */
export async function createSettled(
  db: Firestore,
  ref: SchedulerMarkerRef,
  meta: { job: string; reason: string; at?: Date },
): Promise<boolean> {
  const at = meta.at ?? new Date();
  try {
    await db
      .collection(SCHEDULER_MARKERS_COLLECTION)
      .doc(ref.id)
      .create({
        job: meta.job,
        family: ref.family,
        ...ref.fields,
        claimedAt: at,
        // Never claimed for work, so it has spent no attempt on anything.
        attempts: 0,
        sentAt: null,
        failedAt: null,
        skippedReason: meta.reason.slice(0, 200),
        lastError: null,
        expiresAt: schedulerMarkerExpiry(at),
      });
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    throw err;
  }
}

/** What an admin Retry did, and when it did nothing, why. */
export type RetryOutcome =
  | { retried: true }
  | { retried: false; reason: "missing" | "sent" | "in-flight" };

/**
 * Admin Retry, from the scheduler panel: put a SETTLED marker back in play.
 *
 * Attempts go back to 0 rather than being decremented, so an admin who
 * retries three times gets three more attempts each time. That is the right
 * shape: the attempt counter exists to stop an UNATTENDED loop, and a human
 * clicking Retry is attendance.
 *
 * TWO REFUSALS, and they guard different things:
 *
 *  - `sentAt` set: the work went out. Clearing the marker would let the next
 *    tick re-derive it and send it again, which is the duplicate the whole
 *    claim-before-send order exists to prevent.
 *  - neither `failedAt` nor `skippedReason` set: the marker is IN FLIGHT. A
 *    tick may be between its claim and its stamp at this very moment, and
 *    resetting `attempts` in front of it hands the same unit of work to the
 *    next tick while the first one is still doing it. An in-flight marker
 *    that is genuinely stuck needs no button: the re-claim rule picks it up
 *    after `reclaimAfterMinutes`, and this is only reachable at all because
 *    the panel takes a marker id.
 *
 * A skipped marker IS resettable, deliberately: the panel never offers Retry
 * on one (Stuck sends lists failures), but "skipped as stale" is a judgement
 * the job made about the clock, and an admin who decides the send is still
 * worth making is entitled to overrule it.
 */
export async function retryFailedMarker(
  db: Firestore,
  markerId: string,
  actorUid: string,
): Promise<RetryOutcome> {
  const docRef = db.collection(SCHEDULER_MARKERS_COLLECTION).doc(markerId);
  const snap = await docRef.get();
  if (!snap.exists) return { retried: false, reason: "missing" };
  const marker = normalizeSchedulerMarker(
    markerId,
    snap.data() as Record<string, unknown>,
  );
  if (marker.sentAt !== null) return { retried: false, reason: "sent" };
  if (marker.failedAt === null && marker.skippedReason === null) {
    return { retried: false, reason: "in-flight" };
  }
  await docRef.set(
    {
      failedAt: null,
      skippedReason: null,
      attempts: 0,
      lastError: null,
      // Back in play means back to live, so the retention clock a skip
      // started is cleared with the skip that started it.
      expiresAt: null,
      retriedAt: FieldValue.serverTimestamp(),
      retriedByUid: actorUid,
    },
    { merge: true },
  );
  return { retried: true };
}
