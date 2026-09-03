import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  resolveSessions,
  sessionInstants,
  type ResolvedSession,
} from "@/lib/courses/sessions";
import {
  buildRegisterFollowUpTask,
  isOurFollowUpTask,
  isRegisterUnmarked,
  isWithinFollowUpWindow,
  followUpDueAt,
  nextScanCursor,
  registerFollowUpFallbackTaskId,
  registerFollowUpTaskId,
  runsToScan,
} from "@/lib/courses/unmarkedRegisters";
import { readCoursesConfig, type CoursesConfig } from "@/lib/firestore/config";
import {
  attendanceDocId,
  normalizeCourseAttendance,
} from "@/lib/firestore/courseAttendance";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseRun, type CourseRunStatus } from "@/lib/firestore/courses";
import {
  pruneFailures,
  readSchedulerCursor,
  sameFailures,
  writeSchedulerCursor,
} from "@/lib/firestore/schedulerCursors";
import { TASK_FIELD_LIMITS } from "@/lib/firestore/tasks";
import {
  claim,
  isStaleWork,
  stampError,
  stampSent,
  stampSkipped,
  unmarkedRegisterMarker,
} from "../markers";
import type { JobContext, JobRegistration, JobResult } from "../registry";

/**
 * THE UNMARKED-REGISTER FOLLOW-UP JOB.
 *
 * A facilitator who never presses PUSH ATTENDANCE takes two things from their
 * group at once: the register (so every member carries a session in a
 * denominator reviewers read as a shortfall) and the next week's reminder
 * email, which the push is what sends. Before this job the only way to notice
 * was to open the group's register and look. Now a card lands on every admin's
 * committee board once the grace has passed.
 *
 * The arithmetic (the window, the "unmarked" predicate, the cursor, the task
 * payload, the read-back decision) is PURE and lives in
 * `src/lib/courses/unmarkedRegisters.ts` with its own unit suite. This file is
 * the Firestore half: what it reads, in what order, and what it does when the
 * id it wants is already taken.
 *
 * ── THE SCAN WINDOW ─────────────────────────────────────────────────────────
 * Sessions whose END instant is between the grace
 * (`config/courses.unmarkedRegisterGraceHours`, default 36) and the grace plus
 * 24 hours, over runs whose status is in `NUDGING_STATUSES`.
 *
 * NOT `running` ALONE, and that is not a widening for its own sake. The
 * pre-course opens on 21 September and runs its six sessions while the
 * admission round is still open, so its run sits at `applications-open` for
 * the whole of it. Scanning `running` only would mean the ONE cohort this job
 * exists for, brand-new facilitators marking their first ever register, is the
 * one cohort it never looks at.
 *
 * ── THE READ BUDGET IS THE REAL CEILING ─────────────────────────────────────
 * `maxFollowUpTasksPerTick` caps WRITES, and writes are not where a tick runs
 * out of time: a quiet week writes nothing at all and still walks every run,
 * every group and every session in the band. So the scan carries its own
 * wall-clock budget (`config/courses.unmarkedScanBudgetMs`, floored by
 * whatever the tick has left) and a RESUMABLE CURSOR over the run list. Out of
 * time means "stop, remember the last run finished, report hasMore"; the
 * re-arm or the next tick picks the list up after it. A run interrupted
 * part-way through does NOT advance the cursor: it is rescanned from its first
 * group next time, which costs reads and writes nothing, because every unit of
 * work is guarded by its own marker.
 *
 * ── ORDER, WHICH IS NOT NEGOTIABLE ──────────────────────────────────────────
 *   1. claim the marker `unmarked__{groupId}__{sessionKey}` with `.create()`;
 *   2. mint the task;
 *   3. stamp `sentAt`.
 * Claim first turns a crash into a MISSED card (recoverable by the re-claim
 * rule) rather than into a second card on nine people's boards.
 *
 * ── ONE BAD ITEM NEVER THROWS ───────────────────────────────────────────────
 * A group with a corrupt calendar, a run whose document vanished mid-scan, a
 * task id somebody has squatted: each is recorded on its own marker or in the
 * log and the scan carries on. That holds at all three levels: a session whose
 * claim or stamp throws, a group whose register read throws, and a run whose
 * whole scan throws are each caught where they happen, counted into the pass's
 * summary, and followed by the next unit of work. The only throw that escapes
 * this file is one from the reads before the loop, which means the database
 * itself is unavailable and is the tick's to report.
 *
 * A run that throws is NOT marked finished, so the cursor does not advance
 * over it and the next full pass reaches it again. A run that keeps throwing
 * is counted (`config/schedulerCursors`, this job's `failures` map) and, after
 * {@link MAX_RUN_SCAN_FAILURES} consecutive passes, stepped over so one
 * poisoned cohort cannot spend the whole term's budget failing. Stepping over
 * is logged every pass it happens, and the count resets the moment the run
 * scans cleanly.
 */

const JOB_ID = "courses-unmarked-registers";

/**
 * The statuses a live cohort can be in, the same allowlist the run-level nudge
 * and the week mirror use. An ALLOWLIST so a status added later fails closed:
 * `draft` has no cohort, and `completed` or `cancelled` must not raise work
 * about a term that is over.
 */
const NUDGING_STATUSES: CourseRunStatus[] = [
  "applications-open",
  "applications-closed",
  "running",
];

/**
 * How many live runs one pass will consider. Well above anything the platform
 * plans (three streams, three fellowships, a pre-course) and low enough that
 * the id query cannot become the thing that busts the budget. Hitting it is
 * logged rather than silently truncating the term.
 */
const MAX_CANDIDATE_RUNS = 200;

/** Groups read per run, per page. Runs have single-figure group counts. */
const GROUP_PAGE_SIZE = 50;

/**
 * Consecutive passes a run may fail before the scan steps over it.
 *
 * Three, so a transient Firestore blip (which is what most of these are) is
 * ridden out and a genuinely poisoned run stops costing a pass's reads within
 * the hour. Stepping over is never silent: it is logged on every pass and
 * counted into the tick's receipt, and the count clears the moment the run
 * scans cleanly again.
 */
const MAX_RUN_SCAN_FAILURES = 3;

type ScanResult = {
  processed: number;
  /** Units of work that threw and were carried past. */
  failed: number;
  /** False when the budget or the write cap stopped this run part-way. */
  complete: boolean;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every admin uid, sorted, capped at `TASK_FIELD_LIMITS.maxCompleters`.
 *
 * The cap is the tasks rules': `completerUids.size() <= 10` on both the create
 * and the committee update lane. A task minted with eleven completers would be
 * one no SU-committee member could ever edit, so an eleventh admin would
 * quietly make every follow-up admin-only to change. Sorted so the ten are the
 * same ten on every tick, and the overflow is logged rather than hidden.
 */
async function readAdminUids(db: Firestore): Promise<string[]> {
  const snap = await db
    .collection("users")
    .where("role", "==", "admin")
    // Ids only. The job needs no profile field, and an admin's document is the
    // most PII-dense one this platform holds.
    .select()
    .get();
  const uids = snap.docs.map((doc) => doc.id).sort();
  if (uids.length > TASK_FIELD_LIMITS.maxCompleters) {
    console.warn(
      `[scheduler:${JOB_ID}] more admins than a task may carry; assigning the first`,
      TASK_FIELD_LIMITS.maxCompleters,
      "of",
      uids.length,
    );
  }
  return uids.slice(0, TASK_FIELD_LIMITS.maxCompleters);
}

/**
 * The live runs' ids, ids only.
 *
 * A PROJECTION rather than a cursor-paged read of whole documents, on purpose:
 * it is served by the automatic single-field index on `status` (no composite
 * index is owed, and none was added), it needs no `orderBy` and therefore no
 * index on a second field, and the ordering the cursor resumes against is done
 * in memory by `runsToScan` where it is unit-testable. The run documents
 * themselves are read one at a time, only for the runs this pass reaches.
 */
async function readCandidateRunIds(db: Firestore): Promise<string[]> {
  const snap = await db
    .collection("courseRuns")
    .where("status", "in", NUDGING_STATUSES)
    .select()
    .limit(MAX_CANDIDATE_RUNS)
    .get();
  if (snap.size >= MAX_CANDIDATE_RUNS) {
    console.warn(
      `[scheduler:${JOB_ID}] candidate run cap reached; some live runs were not scanned this pass`,
      snap.size,
    );
  }
  return snap.docs.map((doc) => doc.id);
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

type FollowUpArgs = {
  db: Firestore;
  ctx: JobContext;
  runId: string;
  courseTitle: string;
  groupId: string;
  groupName: string;
  session: ResolvedSession;
  dueAt: Date;
  adminUids: string[];
};

/**
 * Claim, mint, stamp. Returns true when this unit of work was acted on (which
 * includes being consciously skipped as stale: the marker records that the
 * work was SEEN).
 */
async function raiseFollowUp(args: FollowUpArgs): Promise<boolean> {
  const { db, ctx, runId, groupId, session } = args;
  const marker = unmarkedRegisterMarker(groupId, session.sessionKey);

  const outcome = await claim(db, marker, { job: JOB_ID, policy: ctx.policy });
  if (!outcome.claimed) return false;

  // Belt to the window's braces. The band above already excludes anything
  // older than the grace plus 24 hours, so this is unreachable today; it
  // becomes load-bearing the moment somebody widens the band, and a chase for
  // a session three days gone is noise on a board rather than a follow-up.
  if (isStaleWork(args.dueAt, ctx.now, ctx.maxLateHours)) {
    await stampSkipped(db, marker.id, "stale", ctx.now);
    return true;
  }

  const payload = buildRegisterFollowUpTask({
    runId,
    groupId,
    session,
    courseTitle: args.courseTitle,
    groupName: args.groupName,
    adminUids: args.adminUids,
    // The first admin by uid, so the same run of the job files the card the
    // same way twice. `creatorUid` is read by the board and by the rules'
    // personal-lane delete branch, so it has to be a real account.
    creatorUid: args.adminUids[0],
    dueDate: args.dueAt,
    now: ctx.now,
    limits: {
      title: TASK_FIELD_LIMITS.title,
      description: TASK_FIELD_LIMITS.description,
    },
  });

  const primaryId = registerFollowUpTaskId(runId, groupId, session.sessionKey);
  try {
    const landed = await createFollowUp(db, primaryId, payload, {
      runId,
      adminUids: args.adminUids,
    });
    if (landed === "occupied") {
      // ── THE SQUAT ───────────────────────────────────────────────────────
      // The tasks create rule pins `sourceRef` to null and constrains NEITHER
      // `source` NOR the doc id on the committee lane, so an SU-recognised
      // committee member can create a task at exactly this id, and any
      // signed-in member can squat it on the personal lane. The read-back
      // above is what tells the two apart; this is what happens when it says
      // the document is not ours. Nothing is overwritten and nothing is
      // deleted: the card goes to a second deterministic id and the collision
      // is logged, because an id nobody should have been able to reach is
      // worth seeing.
      const fallbackId = registerFollowUpFallbackTaskId(
        runId,
        groupId,
        session.sessionKey,
      );
      console.warn(
        `[scheduler:${JOB_ID}] follow-up id occupied by a foreign task, using the fallback id`,
        { runId, groupId, sessionKey: session.sessionKey, primaryId, fallbackId },
      );
      const second = await createFollowUp(db, fallbackId, payload, {
        runId,
        adminUids: args.adminUids,
      });
      if (second === "occupied") {
        // Both ids taken by something that is not ours. Leave the marker
        // unsent so the re-claim rule tries again, and let it reach
        // `failedAt` and the panel's Stuck sends list rather than pretending
        // a card exists.
        await stampError(
          db,
          marker.id,
          new Error("both the follow-up id and its fallback are occupied"),
        );
        return false;
      }
    }
  } catch (err) {
    console.error(`[scheduler:${JOB_ID}] could not mint the follow-up task`, {
      runId,
      groupId,
      sessionKey: session.sessionKey,
      err,
    });
    await stampError(db, marker.id, err);
    return false;
  }

  await stampSent(db, marker.id, ctx.now);
  return true;
}

/**
 * `.create()` the task, and on ALREADY_EXISTS decide whose document is there.
 *
 * "created" and "ours" are both success: the second is the crash-between-claim-
 * and-stamp case, where a previous tick minted the card and never got to say
 * so. "occupied" is somebody else's document at our id.
 */
async function createFollowUp(
  db: Firestore,
  taskId: string,
  payload: Record<string, unknown>,
  expect: { runId: string; adminUids: readonly string[] },
): Promise<"created" | "ours" | "occupied"> {
  const ref = db.collection("tasks").doc(taskId);
  try {
    await ref.create(payload);
    return "created";
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const existing = await ref.get();
  return isOurFollowUpTask(existing.data(), expect) ? "ours" : "occupied";
}

/**
 * ALREADY_EXISTS out of `.create()`. The Admin SDK surfaces the raw gRPC
 * status (6); the string forms are accepted because the emulator and some
 * transport paths report the canonical name instead.
 */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

async function scanRun(
  db: Firestore,
  ctx: JobContext,
  runId: string,
  opts: {
    config: CoursesConfig;
    adminUids: string[];
    deadlineMs: number;
    remainingWrites: number;
  },
): Promise<ScanResult> {
  let processed = 0;
  let failed = 0;

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  // Settled, renamed or destroyed between the id query and here. Nothing to
  // chase and nothing to record: the next pass will not list it.
  if (!runSnap.exists) return { processed, failed, complete: true };
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
  if (!NUDGING_STATUSES.includes(run.status)) {
    return { processed, failed, complete: true };
  }

  const groupsSnap = await db
    .collection("courseGroups")
    .where("runId", "==", runId)
    .limit(GROUP_PAGE_SIZE)
    .get();
  if (groupsSnap.size >= GROUP_PAGE_SIZE) {
    // Runs have single-figure group counts, so this is a shape nobody has
    // built rather than a limit anybody will hit. Said out loud anyway: an
    // uncapped query here is how one mis-seeded run eats a whole tick, and a
    // silent truncation is how a group stops being chased with nothing
    // anywhere to say why.
    console.warn(`[scheduler:${JOB_ID}] group cap reached, some groups were not scanned`, {
      runId,
      cap: GROUP_PAGE_SIZE,
    });
  }

  for (const groupDoc of groupsSnap.docs) {
    if (Date.now() >= opts.deadlineMs) return { processed, failed, complete: false };
    if (processed >= opts.remainingWrites) {
      return { processed, failed, complete: false };
    }

    const group = normalizeCourseGroup(groupDoc.id, groupDoc.data() ?? {});
    // A corrupt plan or a half-authored calendar yields sessions with no
    // date, and `isWithinFollowUpWindow` reads a missing instant as "cannot
    // say" rather than as "now". So a run whose dates have not been typed
    // raises nothing, which is the only safe answer.
    let due: ResolvedSession[] = [];
    try {
      due = resolveSessions(run, group).filter((session) =>
        isWithinFollowUpWindow(
          sessionEnd(session),
          ctx.now,
          opts.config.unmarkedRegisterGraceHours,
        ),
      );
    } catch (err) {
      console.error(`[scheduler:${JOB_ID}] could not resolve a group's sessions`, {
        runId,
        groupId: group.id,
        err,
      });
      continue;
    }
    if (due.length === 0) continue;

    // One round trip for the whole group's candidate registers. The addressed
    // id is `attendanceDocId`, the same one the register grid and the push
    // write, so a register that exists is found rather than queried for.
    const refs = due.map((session) =>
      db
        .collection("courseAttendance")
        .doc(
          attendanceDocId(runId, group.id, session.weekNumber, session.occurrence),
        ),
    );
    // The one read this loop cannot do without, so it is guarded like the
    // rest: a group whose registers cannot be read is a group skipped for a
    // pass, not a run abandoned half way down its group list.
    let registers;
    try {
      registers = await db.getAll(...refs);
    } catch (err) {
      console.error(`[scheduler:${JOB_ID}] could not read a group's registers`, {
        runId,
        groupId: group.id,
        err,
      });
      failed += 1;
      continue;
    }

    for (let i = 0; i < due.length; i += 1) {
      if (Date.now() >= opts.deadlineMs) {
        return { processed, failed, complete: false };
      }
      if (processed >= opts.remainingWrites) {
        return { processed, failed, complete: false };
      }

      const snap = registers[i];
      // Read through the collection's own normaliser rather than by poking at
      // raw fields: `held` defaults TRUE there (only an explicit `false` is
      // the facilitator saying the session did not happen) and `pushedAt` is
      // a Timestamp that has to become a Date before anything compares it.
      const register = snap.exists
        ? normalizeCourseAttendance(snap.id, snap.data() ?? {})
        : null;
      const unmarked = isRegisterUnmarked({
        exists: snap.exists,
        held: register ? register.held : true,
        pushedAt: register?.pushedAt ?? null,
      });
      if (!unmarked) continue;

      const endsAt = sessionEnd(due[i]);
      if (endsAt === null) continue;
      // Claim, mint, stamp: three Firestore round trips, any of which can
      // throw on its own. Caught HERE rather than a level up so a marker the
      // job could not stamp costs one session rather than the rest of the
      // run's groups, and so the tick's receipt says how many.
      let acted = false;
      try {
        acted = await raiseFollowUp({
          db,
          ctx,
          runId,
          courseTitle: run.courseTitle || run.label,
          groupId: group.id,
          groupName: group.name,
          session: due[i],
          dueAt: followUpDueAt(endsAt, opts.config.unmarkedRegisterGraceHours),
          adminUids: opts.adminUids,
        });
      } catch (err) {
        console.error(`[scheduler:${JOB_ID}] follow-up failed for a session`, {
          runId,
          groupId: group.id,
          sessionKey: due[i].sessionKey,
          err,
        });
        failed += 1;
        continue;
      }
      if (acted) processed += 1;
    }
  }

  return { processed, failed, complete: true };
}

/**
 * The session's end instant, or null when it has no resolvable date.
 *
 * A null is "cannot say", never "now": a run whose dates have not been typed
 * must raise nothing at all rather than a card per group per week.
 */
function sessionEnd(session: ResolvedSession): Date | null {
  return sessionInstants(session).endsAt;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

async function handler(ctx: JobContext): Promise<JobResult> {
  const db = getAdminDb();
  if (!db) return { processed: 0, hasMore: false, note: "no database" };

  const config = await readCoursesConfig(db);
  // The tick's remaining time is the hard bound; the config value is this
  // job's own, smaller, self-imposed one. Whichever is shorter wins, so a job
  // configured with a generous budget can never eat the tick.
  const budgetMs = Math.max(
    0,
    Math.min(config.unmarkedScanBudgetMs, ctx.budget.remainingMs()),
  );
  const deadlineMs = Date.now() + budgetMs;
  const writeCap = Math.max(
    0,
    Math.min(ctx.maxPerTick, config.maxFollowUpTasksPerTick),
  );

  const adminUids = await readAdminUids(db);
  if (adminUids.length === 0) {
    // Nobody to assign it to. A task with no completers is invisible on every
    // board, so raising one would be worse than reporting the gap.
    ctx.log("no admin accounts, nothing to assign a follow-up to");
    return { processed: 0, hasMore: false, note: "no admins" };
  }

  const cursor = await readSchedulerCursor(db, JOB_ID);
  const candidates = await readCandidateRunIds(db);
  const queue = runsToScan(candidates, cursor.at);
  // Counts for runs that are still listed. A run destroyed or settled since
  // its last failure takes its count with it rather than sitting in the
  // document for the rest of the platform's life.
  const failures = pruneFailures(cursor.failures, candidates);

  let processed = 0;
  let hasMore = false;
  let lastFinished: string | null = null;
  let failedRuns = 0;
  let steppedOver = 0;
  let failedItems = 0;

  for (const runId of queue) {
    if (Date.now() >= deadlineMs || processed >= writeCap) {
      hasMore = true;
      break;
    }

    if ((failures[runId] ?? 0) >= MAX_RUN_SCAN_FAILURES) {
      // Poisoned: it has thrown on every one of the last few passes, so it is
      // stepped over rather than allowed to spend this pass's budget failing
      // again. Said out loud on every pass it happens, and counted into the
      // receipt, because a run nobody scans is exactly the silence this job
      // exists to remove. Treated as finished so the cursor may move past it.
      console.warn(`[scheduler:${JOB_ID}] stepping over a run that keeps failing`, {
        runId,
        failures: failures[runId],
      });
      steppedOver += 1;
      lastFinished = runId;
      continue;
    }

    let result: ScanResult;
    try {
      result = await scanRun(db, ctx, runId, {
        config,
        adminUids,
        deadlineMs,
        remainingWrites: writeCap - processed,
      });
    } catch (err) {
      // One bad run never stops the scan: the rest of the queue is scanned
      // anyway. `lastFinished` is left where it was, so this run does not
      // advance the cursor and a pass that reaches the end of the queue
      // clears it, which puts this run back at the top of the next pass.
      console.error(`[scheduler:${JOB_ID}] run scan failed`, { runId, err });
      failures[runId] = (failures[runId] ?? 0) + 1;
      failedRuns += 1;
      continue;
    }
    // CONSECUTIVE, so a run that scans cleanly starts again from zero.
    delete failures[runId];
    processed += result.processed;
    failedItems += result.failed;
    if (!result.complete) {
      hasMore = true;
      break;
    }
    lastFinished = runId;
  }

  // The cursor advances only over runs finished END TO END. Cleared when the
  // queue ran out, so the next pass starts from the top of the list. When
  // nothing finished at all (a tick that entered with a sliver of budget) the
  // cursor it came in with is kept: writing null there would silently restart
  // the whole list and the tail would never be reached. Written only when it
  // actually moved: a tick every fifteen minutes over a term is several
  // thousand writes of the same value otherwise.
  const nextCursor = nextScanCursor(hasMore, lastFinished, cursor.at);
  if (nextCursor !== cursor.at || !sameFailures(failures, cursor.failures)) {
    await writeSchedulerCursor(db, JOB_ID, nextCursor, failures);
  }

  ctx.log("scan finished", {
    runsQueued: queue.length,
    processed,
    failedRuns,
    failedItems,
    steppedOver,
    hasMore,
    cursor: nextCursor,
  });
  const note = [
    `${processed} follow-up ${processed === 1 ? "task" : "tasks"}`,
    failedRuns > 0
      ? `${failedRuns} run ${failedRuns === 1 ? "scan" : "scans"} failed`
      : null,
    failedItems > 0
      ? `${failedItems} ${failedItems === 1 ? "session" : "sessions"} skipped after an error`
      : null,
    steppedOver > 0
      ? `${steppedOver} ${steppedOver === 1 ? "run" : "runs"} stepped over`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { processed, hasMore, note };
}

export const unmarkedRegistersJob: JobRegistration = {
  id: "courses-unmarked-registers",
  label: "Unmarked registers",
  description:
    "Raises a committee task for every group whose register is still unpushed a day and a half after the session. Turning it off means an unmarked register is invisible again until somebody opens it.",
  // Writes, not reads. The read ceiling is `config/courses.unmarkedScanBudgetMs`
  // and the cursor; this number is what stops one broken calendar burying every
  // admin's board in identical cards. The config value narrows it further.
  maxPerTick: 25,
  // Three days. The 24-hour band above means nothing normally gets near it;
  // it is the guard for a band somebody widens later.
  maxLateHours: 72,
  reclaimAfterMinutes: 20,
  handler,
};
