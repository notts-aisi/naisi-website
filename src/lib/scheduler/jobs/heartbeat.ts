/**
 * The heartbeat job.
 *
 * It sends nothing, writes nothing and claims no marker. Its entire purpose
 * is to be the FIRST registered job so that the machinery around jobs (the
 * secret check, the receipt id scheme, the config kill switch, the budget,
 * the re-arm and the admin panel) is exercised on every tick and visible on
 * the panel before any real send depends on it.
 *
 * The operational rule that goes with it (docs/courses-ops.md): after arming
 * the external scheduler, watch heartbeat receipts accumulate for 24 hours on
 * dev before registering a job that mails anybody. "Is the scheduler running"
 * must be answerable from a surface, not from Cloud Logging.
 *
 * `processed: 1` rather than 0 on purpose: a receipt whose only job reports
 * zero work is indistinguishable from a receipt whose job never ran, and the
 * whole point of this job is to be distinguishable.
 *
 * The type-only import of `JobRegistration` keeps the registry/handler pair
 * free of a runtime cycle.
 */
import type { JobContext, JobRegistration, JobResult } from "../registry";

export const heartbeatJob: JobRegistration = {
  id: "heartbeat",
  label: "Heartbeat",
  description:
    "Does nothing except prove the tick reached the job list. Leave it on: it is how you tell a scheduler that is running from one that is silently down.",
  maxPerTick: 1,
  // Nothing is ever late here: there is no due instant to be late for.
  maxLateHours: 0,
  // This job claims no marker, so nothing reads this number. It is the
  // default rather than 0 anyway: a 0 copied out of here into a job that DOES
  // claim would mean "re-claim immediately", and two ticks a second apart
  // would both send. `policyFor` floors it regardless.
  reclaimAfterMinutes: 20,
  async handler({ now, log }: JobContext): Promise<JobResult> {
    log("heartbeat", { at: now.toISOString() });
    return { processed: 1, hasMore: false, note: "alive" };
  },
};
