/**
 * `schedulerRuns` — one receipt per execution of POST /api/scheduler/tick.
 *
 * The receipt does two jobs:
 *
 *  1. DEDUPE. Cloud Scheduler (and the GitHub Actions fallback) both retry on
 *     a non-2xx, and both can deliver the same nominal tick twice. The doc id
 *     is derived from the request instant floored to a 15-minute UTC boundary,
 *     so two deliveries inside one bucket resolve to the same id and the
 *     second `.create()` fails with ALREADY_EXISTS. That is the whole dedupe:
 *     no transaction, no lock, no lease.
 *
 *  2. OBSERVABILITY. It is the only place an admin can answer "is the
 *     scheduler running" without server logs, which is what the scheduler
 *     panel on /admin/site-status reads.
 *
 * WHY THE DEPTH SUFFIX IS PART OF THE ID. A tick that runs out of budget
 * re-arms itself by calling the endpoint again with `depth + 1`. That re-arm
 * fires seconds later and therefore floors to the SAME bucket. With a bare
 * `tick__{bucket}` id the re-arm would hit ALREADY_EXISTS and return having
 * done nothing, so depth could never leave 0 and every backlog would wait a
 * full 15 minutes for the next external delivery. `tick__{bucket}__d{depth}`
 * gives every re-arm its own receipt while duplicate EXTERNAL deliveries (all
 * of which arrive at depth 0) still collapse onto one id.
 *
 * Consequence, stated here because it is easy to get wrong at the callsite:
 * the deduped early return applies ONLY at depth 0. A collision at depth > 0
 * is an anomaly, not a duplicate delivery, and the tick proceeds through it
 * (idempotency at depth > 0 comes from the per-work markers in
 * `schedulerMarkers`, never from this receipt).
 *
 * This module is deliberately free of runtime imports so the unit suite can
 * transpile it standalone on the repo's Node 20 (see tests/scheduler.test.mjs).
 */

import type { Timestamp } from "firebase-admin/firestore";

export const SCHEDULER_RUNS_COLLECTION = "schedulerRuns";

/** Cadence of the external scheduler, and therefore the dedupe window. */
export const TICK_BUCKET_MINUTES = 15;

/**
 * How many times a tick may re-arm itself before it stops and leaves the rest
 * to the next external delivery. Three re-arms at ~45s each is a little over
 * two minutes of continuous work per 15-minute bucket, which is far more than
 * any autumn-2026 backlog needs and still bounded if a job's `hasMore` ever
 * gets stuck true.
 */
export const MAX_TICK_DEPTH = 3;

/** Why a tick did no work. `null` on a tick that ran jobs. */
export type TickSkipReason = "disabled" | "no-jobs";

export type SchedulerRunJobEntry = {
  id: string;
  processed: number;
  hasMore: boolean;
  durationMs: number;
  error: string | null;
  skipped: string | null;
};

export type SchedulerRun = {
  id: string;
  bucket: string;
  depth: number;
  trigger: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number;
  jobs: SchedulerRunJobEntry[];
  hasMore: boolean;
  rearmed: boolean;
  rearmNote: string | null;
  skipped: TickSkipReason | null;
  receiptCollision: boolean;
};

/**
 * The 15-minute UTC bucket a request instant belongs to, as a compact
 * `YYYYMMDDTHHMMZ` key.
 *
 * UTC on purpose: a London-local bucket would produce two identical keys on
 * the October clock change and none on the March one, which is one hour of
 * silently doubled or silently dropped ticks a year.
 */
export function tickBucketKey(now: Date): string {
  const ms = now.getTime();
  const windowMs = TICK_BUCKET_MINUTES * 60_000;
  const floored = new Date(Math.floor(ms / windowMs) * windowMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(floored.getUTCFullYear(), 4)}` +
    `${pad(floored.getUTCMonth() + 1)}` +
    `${pad(floored.getUTCDate())}` +
    "T" +
    `${pad(floored.getUTCHours())}` +
    `${pad(floored.getUTCMinutes())}` +
    "Z"
  );
}

/** `tick__{bucket}__d{depth}` — the receipt doc id. */
export function tickReceiptId(bucket: string, depth: number): string {
  return `tick__${bucket}__d${depth}`;
}

/** Inverse of {@link tickReceiptId}. `null` for anything not of that shape. */
export function parseTickReceiptId(
  id: string,
): { bucket: string; depth: number } | null {
  const match = /^tick__(\d{8}T\d{4}Z)__d(\d+)$/.exec(id);
  if (!match) return null;
  return { bucket: match[1], depth: Number(match[2]) };
}

/** Human-readable form of a bucket key, for the admin panel. */
export function formatBucketKey(bucket: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(bucket);
  if (!match) return bucket;
  const [, y, mo, d, h, mi] = match;
  return `${y}-${mo}-${d} ${h}:${mi} UTC`;
}

function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  const stamp = raw as Partial<Timestamp> | null | undefined;
  if (stamp && typeof stamp.toDate === "function") return stamp.toDate();
  return null;
}

function toJobEntry(raw: unknown): SchedulerRunJobEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  return {
    id: row.id,
    processed: typeof row.processed === "number" ? row.processed : 0,
    hasMore: row.hasMore === true,
    durationMs: typeof row.durationMs === "number" ? row.durationMs : 0,
    error: typeof row.error === "string" ? row.error : null,
    skipped: typeof row.skipped === "string" ? row.skipped : null,
  };
}

export function normalizeSchedulerRun(
  id: string,
  raw: Record<string, unknown> | undefined,
): SchedulerRun {
  const data = raw ?? {};
  const parsed = parseTickReceiptId(id);
  const jobsRaw = Array.isArray(data.jobs) ? data.jobs : [];
  const jobs: SchedulerRunJobEntry[] = [];
  for (const entry of jobsRaw) {
    const row = toJobEntry(entry);
    if (row !== null) jobs.push(row);
  }
  const skipped = data.skipped;
  return {
    id,
    bucket: typeof data.bucket === "string" ? data.bucket : (parsed?.bucket ?? ""),
    depth: typeof data.depth === "number" ? data.depth : (parsed?.depth ?? 0),
    trigger: typeof data.trigger === "string" ? data.trigger : "external",
    startedAt: toDate(data.startedAt),
    finishedAt: toDate(data.finishedAt),
    durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
    jobs,
    hasMore: data.hasMore === true,
    rearmed: data.rearmed === true,
    rearmNote: typeof data.rearmNote === "string" ? data.rearmNote : null,
    skipped: skipped === "disabled" || skipped === "no-jobs" ? skipped : null,
    receiptCollision: data.receiptCollision === true,
  };
}
