/**
 * The scheduler job registry.
 *
 * Jobs are MODULES, not HTTP routes. There are exactly two scheduler
 * endpoints (POST /api/scheduler/tick and POST /api/admin/scheduler/run)
 * and everything else is an entry in `JOBS` below. A per-job route would mean
 * a per-job secret surface, a per-job timeout and a per-job "is it armed?"
 * question; a registry entry means one endpoint to protect and one panel to
 * read.
 *
 * ORDER IS ALPHABETICAL BY JOB ID, and that is the whole rule. `JOBS` is the
 * one line every job-adding PR touches, so a merge-friendly order beats an
 * editorial one: alphabetical gives each new entry exactly one correct
 * position and three agents appending in parallel stop conflicting in the
 * same place.
 *
 * Nothing depends on the position. The budget is checked BEFORE each job
 * runs, a job the tick could not reach is reported as skipped for budget on
 * the receipt and picked up by the re-arm, and every job derives its due
 * state from live data at tick time rather than from a stored queue, so
 * nothing is lost by being last. In particular the heartbeat is no longer
 * first: what proves the tick is alive is the RECEIPT, which is written
 * whether or not the heartbeat was reached.
 *
 * ADDING A JOB (later PRs): write `src/lib/scheduler/jobs/<name>.ts`
 * exporting a `JobRegistration`, import it here, and append it to `JOBS`. The
 * `SchedulerJobId` union already names every job the courses V3 contract
 * plans, so a new entry needs no type change. That is deliberate: the panel
 * and `config/scheduler` key on those ids, and renaming one after it has
 * shipped orphans its stored enable switch.
 */
import {
  DEFAULT_MARKER_POLICY,
  type MarkerPolicy,
} from "@/lib/firestore/schedulerMarkers";
import { admissionsRemindersJob } from "./jobs/admissionsReminders";
import { heartbeatJob } from "./jobs/heartbeat";

/**
 * Every job id the platform will register. The union is complete ahead of the
 * handlers on purpose (see the module comment).
 *
 * `week-lock-notices` is deliberately absent: the facilitator's attendance
 * push already carries the next-week email, so a second notice would be a
 * duplicate with worse timing.
 */
export const SCHEDULER_JOB_IDS = [
  "heartbeat",
  "admissions-deadline-reminders",
  "admissions-stage-release",
  "courses-unmarked-registers",
  "courses-break-return",
  "newsletter-drain",
] as const;

export type SchedulerJobId = (typeof SCHEDULER_JOB_IDS)[number];

export function isSchedulerJobId(value: unknown): value is SchedulerJobId {
  return (
    typeof value === "string" &&
    (SCHEDULER_JOB_IDS as readonly string[]).includes(value)
  );
}

/**
 * The remaining slice of the tick's wall-clock budget.
 *
 * Handlers must consult this between units of work rather than trusting a
 * count: a 200-recipient cap is not a time bound when one Resend call can
 * take four seconds. `expired()` going true is a normal outcome, reported as
 * `hasMore: true`, not an error.
 */
export type JobBudget = {
  /** Milliseconds left before the tick must start winding up. */
  remainingMs(): number;
  expired(): boolean;
};

/** Structured logging, so a job's lines are attributable in Cloud Logging. */
export type JobLog = (message: string, extra?: Record<string, unknown>) => void;

export type JobContext = {
  /**
   * The tick's single "now". Passed rather than read inside handlers so every
   * due-date derivation in one tick agrees, and so tests can pin it.
   */
  now: Date;
  budget: JobBudget;
  log: JobLog;
  /**
   * The marker policy for THIS job, ready to hand to `claim()`.
   *
   * It is passed rather than looked up because a handler that has to find its
   * own registration to honour its own re-claim window is a handler that will
   * quietly stop honouring it. Built by {@link policyFor}.
   */
  policy: MarkerPolicy;
  /**
   * This job's `maxPerTick` and `maxLateHours`, restated on the context for
   * the same reason: they are limits the HANDLER has to apply (nothing else
   * can count a job's units of work or know what its due instants mean), and
   * a limit a handler has to go and fetch is a limit that drifts.
   */
  maxPerTick: number;
  maxLateHours: number;
};

export type JobResult = {
  /** Units of work actually acted on (sent, stamped, created). */
  processed: number;
  /** True when due work remains, so the tick may then re-arm itself. */
  hasMore: boolean;
  /** Optional one-line summary for the receipt. */
  note?: string;
};

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export type JobRegistration = {
  id: SchedulerJobId;
  /** Panel label. Plain words: an admin reads this at 23:00 during an incident. */
  label: string;
  description: string;
  handler: JobHandler;
  /**
   * Hard ceiling on units of work per tick. Protects the downstream service
   * (Resend, Firestore writes), NOT the 60s Cloud Run timeout. That is what
   * `budget` is for.
   */
  maxPerTick: number;
  /**
   * Work due more than this many hours ago is stamped `skippedReason:
   * "stale"` rather than acted on. Sending a deadline reminder days after the
   * deadline is worse than sending nothing.
   */
  maxLateHours: number;
  /**
   * How long a claimed-but-unsent marker is left alone before another tick
   * may re-claim it. See the re-claim rule in
   * `src/lib/firestore/schedulerMarkers.ts`.
   *
   * Read through {@link policyFor}, never directly: it is floored at
   * {@link MIN_RECLAIM_AFTER_MINUTES}, because a window shorter than a send
   * can legitimately take is a second tick racing the first one.
   */
  reclaimAfterMinutes: number;
  /**
   * What "no row in `config/scheduler`" means for THIS job. Defaults to
   * `true`, which is right for everything that does not mail a human: a job
   * registered by a later PR must not be silently off on an environment
   * nobody has touched the panel on.
   *
   * A job that EMAILS PEOPLE sets it to `false` and ships dark, because the
   * alternative is a job that arms itself the moment it deploys, on whatever
   * live data the environment happens to hold. The owner turns it on from the
   * panel once the data is right and the run is proven. Read it through
   * {@link jobDefaultEnabled}.
   */
  enabledByDefault?: boolean;
};

/** What no stored switch means for this job. See `enabledByDefault`. */
export function jobDefaultEnabled(job: JobRegistration): boolean {
  return job.enabledByDefault !== false;
}

/**
 * The floor under every job's re-claim window.
 *
 * A window of 0 does not mean "never re-claim", it means "re-claim
 * immediately", which is the one value that turns the recovery rule into a
 * duplicate-send machine: two ticks a second apart would both find the same
 * marker reclaimable and both send. Five minutes comfortably exceeds any
 * single Resend call, so the floor is a floor and not a tuning knob.
 */
export const MIN_RECLAIM_AFTER_MINUTES = 5;

/**
 * The marker policy a job's `claim()` calls must use.
 *
 * `maxAttempts` is deliberately NOT per job: three claims with no stamp means
 * something is wrong with the work rather than with the timing, and a job
 * that could set its own cap would eventually set it high enough to loop.
 */
export function policyFor(job: JobRegistration): MarkerPolicy {
  return {
    reclaimAfterMinutes: Math.max(
      job.reclaimAfterMinutes,
      MIN_RECLAIM_AFTER_MINUTES,
    ),
    maxAttempts: DEFAULT_MARKER_POLICY.maxAttempts,
  };
}

/** Registration order, ALPHABETICAL BY JOB ID. See the module header. */
export const JOBS: readonly JobRegistration[] = [
  admissionsRemindersJob,
  heartbeatJob,
];

export function findJob(id: string): JobRegistration | null {
  return JOBS.find((job) => job.id === id) ?? null;
}
