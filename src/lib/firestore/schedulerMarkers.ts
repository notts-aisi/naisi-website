/**
 * `schedulerMarkers`: the single claim-before-send marker collection for
 * EVERY scheduler-tick job.
 *
 * A tick job derives its due work from live data at tick time (no queue, no
 * stored due list), so a missed tick catches up on its own. What stops a
 * caught-up tick re-sending is a marker: a deterministic, construct-only doc
 * id per unit of work, created with `.create()` BEFORE the send and stamped
 * `sentAt` after it.
 *
 * HOUSE RULE. Scheduler-tick markers live here. Human-triggered course send
 * markers stay in `courseNudges` (existing collection, existing rules, no
 * rules deploy). Do not mix the two: this collection is `allow read, write:
 * if false` precisely so a client cannot pre-create an id and suppress a send
 * it does not want, and `courseNudges` is not shaped for that threat.
 *
 * THE RE-CLAIM RULE (the part that is easy to leave out and expensive to
 * leave out). Claim-before-send means a failure BETWEEN the claim and the
 * stamp (one Resend 5xx, one container eviction, one budget cut) leaves a
 * marker with no `sentAt`. Without a recovery rule every later tick derives
 * the same work, sees the marker, and skips: permanent silent non-delivery of
 * exactly the mail somebody is waiting for. So a marker with no `sentAt`
 * whose `claimedAt` is older than `reclaimAfterMinutes` is RECLAIMABLE, up to
 * `maxAttempts` claims in total, after which it is stamped `failedAt` and
 * surfaced with a Retry action on the admin scheduler panel. A stuck marker
 * must be visible, not inferred.
 *
 * Work that is simply too late (a tick that has been down for days) is
 * stamped `skippedReason: "stale"` rather than mailed, per each job's
 * `maxLateHours`. Sending a "your application closes in 7 days" email nine
 * days after the deadline is worse than sending nothing.
 *
 * Every component of a marker id is ALSO stored as a field, so the panel and
 * any future cleanup can query markers without parsing ids.
 *
 * This module is deliberately free of runtime imports so the unit suite can
 * transpile it standalone on the repo's Node 20 (see tests/scheduler.test.mjs).
 */

import type { Timestamp } from "firebase-admin/firestore";

export const SCHEDULER_MARKERS_COLLECTION = "schedulerMarkers";

/**
 * The id prefixes in use. One per family of work, so a marker id says what it
 * suppresses at a glance and a family can be swept without a field query.
 */
export const MARKER_FAMILIES = [
  "remind",
  "stagerel",
  "unmarked",
  "breakret",
] as const;

export type SchedulerMarkerFamily = (typeof MARKER_FAMILIES)[number];

/**
 * An id plus the field bag that must be written alongside it. Returning both
 * from one builder is what keeps "every component is also stored as a field"
 * true: a caller cannot mint an id and forget the fields.
 */
export type SchedulerMarkerRef = {
  id: string;
  family: SchedulerMarkerFamily;
  fields: Record<string, string>;
};

/**
 * A component that is a doc id the platform minted (a round id, a run id, a
 * group id, a uid).
 *
 * NOTE these MAY contain the `__` separator, and rejecting it would be a bug,
 * not a safety check: `slugId()` builds every doc id in this codebase as
 * `{slug}__{8-char-base36}`, so `autumn-2026-intake__k3f9a2b1` is the NORMAL
 * shape of a round id. The ids built below are therefore not parseable back
 * into their components by splitting on `__`, and nothing tries to: every
 * component is stored as a FIELD, and only the family prefix (which never
 * contains `__`) is ever read back off the id.
 *
 * What that leaves is a theoretical collision: two different tuples
 * concatenating to the same string. It does not arise here, because at most
 * one component per id is a slug id whose tail is free-form, and every slug
 * id carries a fixed 8-character suffix, so there is no second valid split.
 * Callers pass platform ids, never user input.
 *
 * `/` is rejected because Firestore rejects it in a doc id outright, and `.`
 * because a component that is `.` or `..` would make an illegal id. This
 * throws rather than sanitising: a silently mangled component would collapse
 * two units of work onto one marker and suppress a real send.
 */
function assertDocIdComponent(name: string, value: string): string {
  if (value === "") {
    throw new Error(`scheduler marker: \`${name}\` must not be empty`);
  }
  if (value.includes("/") || value.includes(".")) {
    throw new Error(
      `scheduler marker: \`${name}\` must not contain "/" or "." (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * A component this platform composes itself: a date key, a session key, a
 * stage id. These are fully under our control, so they additionally must not
 * contain `__`: keeping the tail of every marker id separator-free is what
 * removes the last of the ambiguity described above.
 */
function assertKeyComponent(name: string, value: string): string {
  assertDocIdComponent(name, value);
  if (value.includes("__")) {
    throw new Error(
      `scheduler marker: \`${name}\` must not contain "__" (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** `remind__{roundId}__{uid}__{dueAtKey}`, an admissions deadline reminder. */
export function reminderMarker(
  roundId: string,
  uid: string,
  dueAtKey: string,
): SchedulerMarkerRef {
  const fields = {
    roundId: assertDocIdComponent("roundId", roundId),
    // A Firebase uid is 28 alphanumeric characters, so it belongs in the
    // stricter bucket even though it is an id rather than a key.
    uid: assertKeyComponent("uid", uid),
    dueAtKey: assertKeyComponent("dueAtKey", dueAtKey),
  };
  return {
    id: `remind__${fields.roundId}__${fields.uid}__${fields.dueAtKey}`,
    family: "remind",
    fields,
  };
}

/** `stagerel__{roundId}__{stageId}`, an application stage release notice. */
export function stageReleaseMarker(
  roundId: string,
  stageId: string,
): SchedulerMarkerRef {
  const fields = {
    roundId: assertDocIdComponent("roundId", roundId),
    stageId: assertKeyComponent("stageId", stageId),
  };
  return {
    id: `stagerel__${fields.roundId}__${fields.stageId}`,
    family: "stagerel",
    fields,
  };
}

/** `unmarked__{groupId}__{sessionKey}`, an unmarked-register follow-up. */
export function unmarkedRegisterMarker(
  groupId: string,
  sessionKey: string,
): SchedulerMarkerRef {
  const fields = {
    groupId: assertDocIdComponent("groupId", groupId),
    sessionKey: assertKeyComponent("sessionKey", sessionKey),
  };
  return {
    id: `unmarked__${fields.groupId}__${fields.sessionKey}`,
    family: "unmarked",
    fields,
  };
}

/** `breakret__{runId}__{groupId}__{slotStartKey}`, a back-after-the-break notice. */
export function breakReturnMarker(
  runId: string,
  groupId: string,
  slotStartKey: string,
): SchedulerMarkerRef {
  const fields = {
    runId: assertDocIdComponent("runId", runId),
    groupId: assertDocIdComponent("groupId", groupId),
    slotStartKey: assertKeyComponent("slotStartKey", slotStartKey),
  };
  return {
    id: `breakret__${fields.runId}__${fields.groupId}__${fields.slotStartKey}`,
    family: "breakret",
    fields,
  };
}

/** The family a stored id belongs to, or `null` if it is not one of ours. */
export function markerFamilyOf(id: string): SchedulerMarkerFamily | null {
  const prefix = id.split("__", 1)[0];
  return (MARKER_FAMILIES as readonly string[]).includes(prefix)
    ? (prefix as SchedulerMarkerFamily)
    : null;
}

export type SchedulerMarker = {
  id: string;
  job: string;
  family: SchedulerMarkerFamily | null;
  claimedAt: Date | null;
  attempts: number;
  sentAt: Date | null;
  failedAt: Date | null;
  skippedReason: string | null;
  lastError: string | null;
  /** The id components, stored so markers are queryable without parsing ids. */
  components: Record<string, string>;
};

function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  const stamp = raw as Partial<Timestamp> | null | undefined;
  if (stamp && typeof stamp.toDate === "function") return stamp.toDate();
  return null;
}

const COMPONENT_KEYS = [
  "roundId",
  "uid",
  "dueAtKey",
  "stageId",
  "groupId",
  "sessionKey",
  "runId",
  "slotStartKey",
] as const;

export function normalizeSchedulerMarker(
  id: string,
  raw: Record<string, unknown> | undefined,
): SchedulerMarker {
  const data = raw ?? {};
  const components: Record<string, string> = {};
  for (const key of COMPONENT_KEYS) {
    const value = data[key];
    if (typeof value === "string" && value !== "") components[key] = value;
  }
  return {
    id,
    job: typeof data.job === "string" ? data.job : "",
    family: markerFamilyOf(id),
    claimedAt: toDate(data.claimedAt),
    attempts: typeof data.attempts === "number" ? data.attempts : 0,
    sentAt: toDate(data.sentAt),
    failedAt: toDate(data.failedAt),
    skippedReason:
      typeof data.skippedReason === "string" && data.skippedReason !== ""
        ? data.skippedReason
        : null,
    lastError:
      typeof data.lastError === "string" && data.lastError !== ""
        ? data.lastError
        : null,
    components,
  };
}

// ---------------------------------------------------------------------------
// The re-claim rule
// ---------------------------------------------------------------------------

export type MarkerPolicy = {
  /**
   * A claimed-but-unsent marker is left alone until it is OLDER than this.
   * It must comfortably exceed the longest a single send can legitimately
   * take, or a slow-but-healthy send gets a second claim racing it.
   */
  reclaimAfterMinutes: number;
  /** Total claims allowed, first claim included. */
  maxAttempts: number;
};

export const DEFAULT_MARKER_POLICY: MarkerPolicy = {
  reclaimAfterMinutes: 20,
  maxAttempts: 3,
};

export type MarkerDecision =
  /** No marker, or a reclaimable one. `attempts` is the number to write. */
  | { action: "claim"; attempts: number; reclaimed: boolean }
  /** Somebody else holds it, or it is finished. Do nothing. */
  | {
      action: "skip";
      reason: "sent" | "failed" | "skipped" | "in-flight";
    }
  /** Out of attempts. Stamp `failedAt` and surface a Retry on the panel. */
  | { action: "give-up"; attempts: number };

/**
 * Decide what a job should do with an existing marker (or the absence of one).
 *
 * Pure, so it is unit-testable at the boundary without an emulator. The
 * boundary is deliberately EXCLUSIVE: a marker whose age is exactly
 * `reclaimAfterMinutes` is still treated as in flight. Reclaiming on the
 * equality is how you get two sends when a clock rounds a millisecond the
 * wrong way; waiting one more tick costs 15 minutes on an already-failed send.
 */
export function decideMarkerClaim(
  existing: SchedulerMarker | null,
  now: Date,
  policy: MarkerPolicy = DEFAULT_MARKER_POLICY,
): MarkerDecision {
  if (existing === null) return { action: "claim", attempts: 1, reclaimed: false };
  if (existing.sentAt !== null) return { action: "skip", reason: "sent" };
  if (existing.failedAt !== null) return { action: "skip", reason: "failed" };
  if (existing.skippedReason !== null) return { action: "skip", reason: "skipped" };

  // A marker with no claimedAt is corrupt rather than fresh. Treat it as
  // infinitely old so the recovery path can pick it up instead of it being
  // stuck in flight forever.
  const claimedMs = existing.claimedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const ageMinutes = (now.getTime() - claimedMs) / 60_000;
  if (ageMinutes <= policy.reclaimAfterMinutes) {
    return { action: "skip", reason: "in-flight" };
  }
  if (existing.attempts >= policy.maxAttempts) {
    return { action: "give-up", attempts: existing.attempts };
  }
  return {
    action: "claim",
    attempts: existing.attempts + 1,
    reclaimed: true,
  };
}

/**
 * Is this unit of work too old to act on?
 *
 * Every job derives its due instants at tick time, so a scheduler that has
 * been down for two days will happily rediscover Monday's "closes in 7 days"
 * reminder on Wednesday. `maxLateHours` is the per-job answer to "how late is
 * worse than silent"; work past it is stamped `skippedReason: "stale"` so the
 * marker still records that the work was SEEN and consciously dropped.
 */
export function isStaleWork(
  dueAt: Date,
  now: Date,
  maxLateHours: number,
): boolean {
  return now.getTime() - dueAt.getTime() > maxLateHours * 3_600_000;
}
