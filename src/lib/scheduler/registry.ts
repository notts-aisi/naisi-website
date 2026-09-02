/**
 * The scheduler job registry.
 *
 * Jobs are MODULES, not HTTP routes. There are exactly two scheduler
 * endpoints — POST /api/scheduler/tick and POST /api/admin/scheduler/run —
 * and everything else is an entry in `JOBS` below. A per-job route would mean
 * a per-job secret surface, a per-job timeout and a per-job "is it armed?"
 * question; a registry entry means one endpoint to protect and one panel to
 * read.
 *
 * ORDER IS THE CONTRACT. `JOBS` is run in registration order within one time
 * budget, so put cheap, time-critical work first and expensive drains last: a
 * tick that runs out of budget stops partway down the list and reports
 * `hasMore`, and the re-arm resumes from the top with whatever is still due.
 * Nothing is lost either way, because every job derives its due state from
 * live data at tick time rather than from a stored queue.
 *
 * ADDING A JOB (later PRs): write `src/lib/scheduler/jobs/<name>.ts`
 * exporting a `JobRegistration`, import it here, and append it to `JOBS`. The
 * `SchedulerJobId` union already names every job the courses V3 contract
 * plans, so a new entry needs no type change — which is deliberate: the panel
 * and `config/scheduler` key on those ids, and renaming one after it has
 * shipped orphans its stored enable switch.
 */
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
};

export type JobResult = {
  /** Units of work actually acted on (sent, stamped, created). */
  processed: number;
  /** True when due work remains — the tick may then re-arm itself. */
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
   * (Resend, Firestore writes), NOT the 60s Cloud Run timeout — that is what
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
   */
  reclaimAfterMinutes: number;
};

/**
 * Registration order. Heartbeat is FIRST and deliberately first: it proves
 * the tick machinery (secret, receipt, config, budget, panel) end to end
 * before any real send hangs off it, and it is cheap enough that it can never
 * be the job that eats the budget.
 */
export const JOBS: readonly JobRegistration[] = [heartbeatJob];

export function findJob(id: string): JobRegistration | null {
  return JOBS.find((job) => job.id === id) ?? null;
}
