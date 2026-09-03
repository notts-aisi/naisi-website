/**
 * Scheduler kill switch and per-job state: a single Firestore doc at
 * `config/scheduler`, structural clone of `config/taskEmails`.
 *
 * `{ enabled, jobs: Record<jobId, { enabled, lastRunAt, lastError }>,
 *    updatedAt, updatedByUid }`.
 *
 * MISSING MEANS ENABLED for the site-wide switch, and for a job it means the
 * JOB'S OWN DEFAULT. A fresh Firestore project, or a job registered by a
 * later PR before anyone has touched the panel, must run: the alternative is
 * a scheduler that is silently off on a new environment and a deadline
 * reminder nobody notices did not send.
 *
 * The exception a job declares for itself is `enabledByDefault: false`
 * (`src/lib/scheduler/registry.ts`), for a job that MAILS PEOPLE and would
 * otherwise arm itself the moment it deployed. `jobStateFor` takes that
 * default as an argument rather than importing the registry, which would be a
 * cycle: the registry imports the jobs, and a job imports this module.
 *
 * A stored row is only an explicit choice when it actually carries an
 * `enabled` boolean. The manual Run now writes `lastRunAt` onto a job's row
 * without one, so a row that exists is NOT on its own evidence that anybody
 * has touched the switch; `enabled: null` is how this module says so.
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
  /**
   * The switch as STORED: `true` or `false` when somebody has set it, `null`
   * when the doc carries no explicit choice for this job. Null is not "on":
   * it is resolved against the job's own default by {@link jobStateFor}.
   */
  enabled: boolean | null;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastProcessed: number;
};

/** A job state with the switch resolved. What every caller actually reads. */
export type ResolvedSchedulerJobState = Omit<SchedulerJobState, "enabled"> & {
  enabled: boolean;
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
    enabled: null,
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
    enabled: typeof row.enabled === "boolean" ? row.enabled : null,
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

/**
 * State for one job, with the switch resolved.
 *
 * `enabledByDefault` is the job's own answer to "what does no stored switch
 * mean", and it is an ARGUMENT rather than a lookup so this module never
 * imports the registry. It defaults to `true`, which is the right answer for
 * everything that does not mail a human.
 */
export function jobStateFor(
  config: SchedulerConfig,
  jobId: string,
  enabledByDefault = true,
): ResolvedSchedulerJobState {
  const stored = config.jobs[jobId] ?? defaultJobState();
  return { ...stored, enabled: stored.enabled ?? enabledByDefault };
}
