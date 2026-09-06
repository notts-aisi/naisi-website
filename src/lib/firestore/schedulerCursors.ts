import "server-only";
import {
  FieldPath,
  FieldValue,
  type Firestore,
  type Timestamp,
} from "firebase-admin/firestore";

/**
 * `config/schedulerCursors`: where a RESUMABLE scheduler job leaves its place.
 *
 * NOT A NEW COLLECTION. It is one more document in the existing server-only
 * `config` collection, which already carries `config/scheduler`,
 * `config/courses` and `config/taskEmails` and already has an explicit
 * `match /config/{doc} { allow read, write: if false; }` block. So this ships
 * with no rules change, no emulator block of its own, no account-deletion
 * sweep (it names no uid) and no destroy-manifest entry (it is not
 * course-scoped: one document holds every job's cursor, and a run dying
 * cannot take it with them).
 *
 * ── WHY A CURSOR AT ALL ─────────────────────────────────────────────────────
 * A job's per-tick cap on WRITES is not a bound on its READS, and the reads
 * are where the 60s ceiling risk lives. The unmarked-register scan walks every
 * live run, every group on it and every session in the band; a platform with
 * three streams, three fellowships and a pre-course can put that comfortably
 * past a tick's budget. Without a cursor the next tick starts at the same
 * place, does the same reads, and the tail of the list is never reached: the
 * groups at the end of the alphabet are the ones that are never chased, and
 * nothing anywhere says so.
 *
 * ── WHY NOT ON `config/scheduler` ───────────────────────────────────────────
 * That document is the panel's: a kill switch and per-job run state, written
 * by the tick after every pass. Machine bookkeeping that a job writes MID-pass
 * would interleave with those writes for no gain, and an admin reading the
 * panel's document should not have to work out which fields are theirs.
 *
 * ── AND WHERE A POISONED ITEM IS COUNTED ────────────────────────────────────
 * The row also carries `failures`, a small map of item id to CONSECUTIVE
 * failed attempts. A scan that throws on the same run every pass would
 * otherwise be retried for the rest of the term, burning the same reads and
 * writing the same log line forever. The count is what lets a job step over
 * an item that has failed enough times, and it is stored beside the cursor
 * rather than in memory because "enough times" spans passes, and a pass is a
 * fresh process.
 *
 * A key is dropped the moment its item scans cleanly, and keys for items the
 * job no longer lists are pruned by the job, so the map is bounded by the
 * number of things currently broken rather than by the age of the platform.
 *
 * ── LOSING IT IS SAFE ───────────────────────────────────────────────────────
 * A missing, stale or hand-cleared cursor means "start from the beginning",
 * which costs a repeated scan and nothing else: every unit of work the scan
 * finds is guarded by its own `schedulerMarkers` claim, so a second look at an
 * already-handled session writes nothing. That is the direction to fail in.
 */

export const SCHEDULER_CURSORS_PATH = {
  collection: "config",
  doc: "schedulerCursors",
} as const;

export type SchedulerCursor = {
  /** The last item this job finished. Null means "start from the top". */
  at: string | null;
  /**
   * Consecutive failed attempts per item id. Absent means none, which is the
   * ordinary case: only the broken things are named here.
   */
  failures: Record<string, number>;
  updatedAt: Date | null;
};

/**
 * How many item ids one job's `failures` map may carry.
 *
 * The map is bookkeeping, not a record: a job whose every item is failing has
 * a problem the log and the panel already show, and a document that grows
 * with the failure is one more thing to go wrong. Ids past the cap are simply
 * not counted, so those items keep being retried, which is the safe direction.
 */
export const MAX_TRACKED_FAILURES = 100;

function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  const stamp = raw as Partial<Timestamp> | null | undefined;
  if (stamp && typeof stamp.toDate === "function") return stamp.toDate();
  return null;
}

/**
 * One job's cursor out of the raw document.
 *
 * Anything unreadable degrades to "start from the top" rather than throwing:
 * a corrupt cursor must not be able to wedge a scan, and the recovery is a
 * repeated pass the markers already make free.
 */
export function normalizeSchedulerCursor(
  raw: Record<string, unknown> | undefined,
  jobId: string,
): SchedulerCursor {
  const row = raw?.[jobId];
  if (row === null || typeof row !== "object") {
    return { at: null, failures: {}, updatedAt: null };
  }
  const data = row as Record<string, unknown>;
  return {
    at: typeof data.at === "string" && data.at !== "" ? data.at : null,
    failures: normalizeFailures(data.failures),
    updatedAt: toDate(data.updatedAt),
  };
}

/**
 * The failure counts, with anything that is not a positive whole number
 * dropped.
 *
 * A corrupt count must read as "not failing" rather than as "failing enough
 * to step over": the cost of the first is a repeated scan, and the cost of
 * the second is a run nobody ever looks at again.
 */
function normalizeFailures(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) continue;
    out[key] = Math.floor(value);
    if (Object.keys(out).length >= MAX_TRACKED_FAILURES) break;
  }
  return out;
}

/**
 * The counts worth carrying into the next pass: the ones whose item the job
 * still lists, capped.
 *
 * Pruning here rather than at the write site is what keeps the document from
 * accumulating a key per run the platform has ever destroyed.
 */
export function pruneFailures(
  failures: Record<string, number>,
  liveIds: readonly string[],
): Record<string, number> {
  const live = new Set(liveIds);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(failures)) {
    if (!live.has(key)) continue;
    out[key] = value;
    if (Object.keys(out).length >= MAX_TRACKED_FAILURES) break;
  }
  return out;
}

/** True when two failure maps say the same thing, so a write can be skipped. */
export function sameFailures(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

export async function readSchedulerCursor(
  db: Firestore,
  jobId: string,
): Promise<SchedulerCursor> {
  const snap = await db
    .collection(SCHEDULER_CURSORS_PATH.collection)
    .doc(SCHEDULER_CURSORS_PATH.doc)
    .get();
  return normalizeSchedulerCursor(
    snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
    jobId,
  );
}

/**
 * Save (or clear) one job's place, and the failure counts that go with it.
 * `at: null` clears the cursor, which is what a job that reached the end of
 * its list writes so the next pass starts from the top.
 *
 * `mergeFields` on THIS JOB'S FIELD, not a plain `merge: true`, and the
 * difference matters. A merging write deep-merges nested maps, so a key
 * removed from `failures` (an item that has just scanned cleanly, or one the
 * job no longer lists) would survive in the stored document forever and the
 * run would stay stepped over. Replacing the whole row at the job's field
 * path makes a removal a removal, while still leaving every other job's row
 * untouched.
 */
export async function writeSchedulerCursor(
  db: Firestore,
  jobId: string,
  at: string | null,
  failures: Record<string, number> = {},
): Promise<void> {
  await db
    .collection(SCHEDULER_CURSORS_PATH.collection)
    .doc(SCHEDULER_CURSORS_PATH.doc)
    .set(
      { [jobId]: { at, failures, updatedAt: FieldValue.serverTimestamp() } },
      { mergeFields: [new FieldPath(jobId)] },
    );
}
