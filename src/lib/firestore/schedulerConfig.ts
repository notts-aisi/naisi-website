/**
 * Scheduler kill switch and per-job state: a single Firestore doc at
 * `config/scheduler`, structural clone of `config/taskEmails`.
 *
 * `{ enabled, jobs: Record<jobId, { enabled, lastRunAt, lastError }>,
 *    updatedAt, updatedByUid }`.
 *
 * MISSING MEANS ENABLED, at both levels. A fresh Firestore project, or a job
 * registered by a later PR before anyone has touched the panel, must run.
 * The alternative is a scheduler that is silently off on a new environment
 * and a deadline reminder nobody notices did not send. Switching a job OFF is
 * an explicit `enabled: false`, exactly like `readTaskEmailConfig`.
 *
 * `config` has no match block in firestore.rules, so it is default-deny to
 * every client and every write here is Admin SDK. (PR5 adds an EXPLICIT
 * `match /config/{doc}` deny block for the same reason `pushSubscriptions`
 * has one: so the lockdown is visible in the file rather than inferred. That
 * block is a documentation change, not a behaviour change, and this module
 * does not depend on it landing.)
 */
import type { Firestore, Timestamp } from "firebase-admin/firestore";

export const SCHEDULER_CONFIG_PATH = {
  collection: "config",
  doc: "scheduler",
} as const;

export type SchedulerJobState = {
  enabled: boolean;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastProcessed: number;
};

export type SchedulerConfig = {
  enabled: boolean;
  jobs: Record<string, SchedulerJobState>;
  updatedAt: Date | null;
  updatedByUid: string | null;
};

/** Cap on the stored error string, so one stack trace cannot bloat the doc. */
export const SCHEDULER_LAST_ERROR_MAX = 500;

function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  const stamp = raw as Partial<Timestamp> | null | undefined;
  if (stamp && typeof stamp.toDate === "function") return stamp.toDate();
  return null;
}

export function defaultJobState(): SchedulerJobState {
  return {
    enabled: true,
    lastRunAt: null,
    lastError: null,
    lastErrorAt: null,
    lastProcessed: 0,
  };
}

function normaliseJobState(raw: unknown): SchedulerJobState {
  if (raw === null || typeof raw !== "object") return defaultJobState();
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === false ? false : true,
    lastRunAt: toDate(row.lastRunAt),
    lastError:
      typeof row.lastError === "string" && row.lastError !== ""
        ? row.lastError
        : null,
    lastErrorAt: toDate(row.lastErrorAt),
    lastProcessed:
      typeof row.lastProcessed === "number" ? row.lastProcessed : 0,
  };
}

export function normalizeSchedulerConfig(
  raw: Record<string, unknown> | undefined,
): SchedulerConfig {
  const data = raw ?? {};
  const jobsRaw =
    data.jobs !== null && typeof data.jobs === "object"
      ? (data.jobs as Record<string, unknown>)
      : {};
  const jobs: Record<string, SchedulerJobState> = {};
  for (const [id, value] of Object.entries(jobsRaw)) {
    jobs[id] = normaliseJobState(value);
  }
  return {
    enabled: data.enabled === false ? false : true,
    jobs,
    updatedAt: toDate(data.updatedAt),
    updatedByUid:
      typeof data.updatedByUid === "string" ? data.updatedByUid : null,
  };
}

export async function readSchedulerConfig(
  db: Firestore,
): Promise<SchedulerConfig> {
  const snap = await db
    .collection(SCHEDULER_CONFIG_PATH.collection)
    .doc(SCHEDULER_CONFIG_PATH.doc)
    .get();
  return normalizeSchedulerConfig(
    snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
  );
}

/** State for one job, defaulted the "missing means enabled" way. */
export function jobStateFor(
  config: SchedulerConfig,
  jobId: string,
): SchedulerJobState {
  return config.jobs[jobId] ?? defaultJobState();
}
