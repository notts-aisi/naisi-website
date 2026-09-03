/**
 * THE UNMARKED-REGISTER FOLLOW-UP: `src/lib/courses/unmarkedRegisters.ts`,
 * plus the source-level orderings in the job and in the attendance push that
 * no pure function can pin.
 *
 * What is being pinned here, and why each one would be expensive to discover
 * in production:
 *
 *  1. THE SCAN BAND'S BOUNDARIES. Inclusive at the grace, exclusive 24 hours
 *     later. Get the bottom wrong and a session is chased an hour early or a
 *     tick late; get the top wrong and either the band and the band after it
 *     both claim the same session (two cards) or neither does (silence). None
 *     of that shows up in a log.
 *  2. THE CURSOR. A resumable scan that forgets where it was does the same
 *     reads every tick and never reaches the tail of the run list, so the
 *     groups at the end of the alphabet are the ones nobody chases and
 *     nothing says so.
 *  3. THE READ-BACK. The tasks create rule constrains neither `source` nor
 *     the doc id on the committee lane, so the deterministic id is
 *     squattable. The three-legged identity test is what makes that
 *     survivable, and each leg is tested on its own.
 *  4. THE ORDERINGS. Marker claimed BEFORE the task is minted and stamped
 *     after; the push's archive AFTER its transaction commits. Both are
 *     policy rather than logic, so both are asserted at the source, exactly
 *     as `course-sessions.test.mjs` asserts the push's own marker ordering.
 *
 * ## The loader dance
 *
 * Lifted from `tests/course-sessions.test.mjs`. This repo's Node is v20 and
 * cannot import a `.ts` file, so the module graph is transpiled in memory
 * with the `typescript` devDependency. Nothing in `STUBS` is reachable from
 * an assertion here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const STUBS = new Map([["server-only", "export {};"]]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed, run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const {
  FOLLOW_UP_WINDOW_HOURS,
  buildRegisterFollowUpTask,
  followUpDueAt,
  isOurFollowUpTask,
  isRegisterUnmarked,
  isWithinFollowUpWindow,
  nextScanCursor,
  registerFollowUpDescription,
  registerFollowUpFallbackTaskId,
  registerFollowUpTaskId,
  registerFollowUpTitle,
  runsToScan,
  sessionDateLabel,
} = await loadTs("lib/courses/unmarkedRegisters.ts");
const { isStaleWork } = await loadTs("lib/firestore/schedulerMarkers.ts");
const { normalizeTask } = await loadTs("lib/firestore/tasks.ts");
const { normalizeSchedulerCursor, pruneFailures, sameFailures } = await loadTs(
  "lib/firestore/schedulerCursors.ts",
);

const source = (relativePath) => readFileSync(join(SRC, relativePath), "utf8");

const JOB = source("lib/scheduler/jobs/unmarkedRegisters.ts");
const REGISTRY = source("lib/scheduler/registry.ts");
const PUSH_ROUTE = source(
  "app/api/courses/groups/[groupId]/attendance/push/route.ts",
);

const HOUR = 3_600_000;
const GRACE = 36;

/** A Tuesday evening session that ended at 19:30 London. */
const ENDED_AT = new Date("2026-09-29T18:30:00Z");
/** `now`, N hours after that session ended. */
const hoursAfter = (n) => new Date(ENDED_AT.getTime() + n * HOUR);

// ===========================================================================
// The scan band
// ===========================================================================

describe("the scan window", () => {
  test("nothing is chased before the grace has passed", () => {
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(0), GRACE), false);
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(12), GRACE), false);
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(35.9), GRACE), false);
  });

  test("the bottom boundary is INCLUSIVE, so the grace is a promise not a race", () => {
    // A session that has just reached its grace is due on THIS tick. On an
    // exclusive boundary the same session waits for the next one, which is
    // fifteen minutes of nothing for no reason.
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(GRACE), GRACE), true);
  });

  test("40 hours old, the PR's own example, is inside the band", () => {
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(40), GRACE), true);
  });

  test("the top boundary is EXCLUSIVE at grace plus 24 hours", () => {
    assert.equal(FOLLOW_UP_WINDOW_HOURS, 24);
    assert.equal(
      isWithinFollowUpWindow(ENDED_AT, hoursAfter(GRACE + 23.9), GRACE),
      true,
    );
    // Exactly at the far edge, and past it: the band has let go. Anything
    // still unmarked here already has its card, and a band that kept
    // returning true would re-derive the whole term's reads on every tick.
    assert.equal(
      isWithinFollowUpWindow(ENDED_AT, hoursAfter(GRACE + 24), GRACE),
      false,
    );
    assert.equal(
      isWithinFollowUpWindow(ENDED_AT, hoursAfter(GRACE + 48), GRACE),
      false,
    );
  });

  test("a session with NO resolvable date is never chased", () => {
    // "Cannot say" must never become "now". A run whose dates have not been
    // typed yet would otherwise raise a card per group per week for a term
    // that has not started.
    assert.equal(isWithinFollowUpWindow(null, hoursAfter(40), GRACE), false);
  });

  test("the grace is read from config, not baked in", () => {
    // A shorter grace moves the whole band with it, both ends.
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(13), 12), true);
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(13), 36), false);
    assert.equal(isWithinFollowUpWindow(ENDED_AT, hoursAfter(37), 12), false);
  });

  test("the due instant is the session end plus the grace", () => {
    assert.equal(
      followUpDueAt(ENDED_AT, GRACE).toISOString(),
      hoursAfter(GRACE).toISOString(),
    );
  });
});

describe("the 72-hour late cap", () => {
  // `maxLateHours` is the job's second belt: the band above already excludes
  // anything older, so this is unreachable today and becomes load-bearing the
  // moment somebody widens the band. A chase for a session three days gone is
  // noise on a board, and the marker records that it was seen and dropped.
  const MAX_LATE = 72;

  test("work inside the cap is acted on", () => {
    const due = followUpDueAt(ENDED_AT, GRACE);
    assert.equal(isStaleWork(due, hoursAfter(GRACE + 1), MAX_LATE), false);
    assert.equal(isStaleWork(due, hoursAfter(GRACE + 71), MAX_LATE), false);
  });

  test("work past the cap is stale, and the boundary is exclusive", () => {
    const due = followUpDueAt(ENDED_AT, GRACE);
    assert.equal(isStaleWork(due, hoursAfter(GRACE + 72), MAX_LATE), false);
    assert.equal(isStaleWork(due, hoursAfter(GRACE + 72.1), MAX_LATE), true);
  });

  test("the registry declares 72, which is the number tested above", () => {
    const block = JOB.slice(JOB.indexOf("export const unmarkedRegistersJob"));
    assert.match(block, /maxLateHours: 72,/);
  });
});

// ===========================================================================
// "unmarked" means "not pushed"
// ===========================================================================

describe("the unmarked predicate", () => {
  test("no register document at all is unmarked", () => {
    assert.equal(
      isRegisterUnmarked({ exists: false, held: true, pushedAt: null }),
      true,
    );
  });

  test("a register that exists but was never pushed is unmarked", () => {
    // Marked but not pushed is the case the honest test exists for: the
    // mirrors are not rebuilt and the group's reminder has not gone, so the
    // register has had none of the effects a pushed one has.
    assert.equal(
      isRegisterUnmarked({ exists: true, held: true, pushedAt: null }),
      true,
    );
  });

  test("a pushed register is not unmarked", () => {
    assert.equal(
      isRegisterUnmarked({ exists: true, held: true, pushedAt: new Date() }),
      false,
    );
  });

  test("a session the facilitator says did not happen is nobody's to chase", () => {
    assert.equal(
      isRegisterUnmarked({ exists: true, held: false, pushedAt: null }),
      false,
    );
  });
});

// ===========================================================================
// The resumable cursor
// ===========================================================================

describe("the run cursor", () => {
  const runs = ["c-run", "a-run", "b-run"];

  test("with no cursor the whole list is scanned, in a stable order", () => {
    assert.deepEqual(runsToScan(runs, null), ["a-run", "b-run", "c-run"]);
  });

  test("a cursor resumes AFTER the run it names", () => {
    assert.deepEqual(runsToScan(runs, "a-run"), ["b-run", "c-run"]);
    assert.deepEqual(runsToScan(runs, "b-run"), ["c-run"]);
  });

  test("a cursor on the last run leaves nothing, so the pass clears it", () => {
    assert.deepEqual(runsToScan(runs, "c-run"), []);
  });

  test("a cursor naming a run that has gone starts from the top", () => {
    // Settled, renamed or destroyed between two ticks. Rescanning is free
    // (every unit of work is marker-guarded) and stalling is silence, so this
    // is the direction to fail in.
    assert.deepEqual(runsToScan(runs, "destroyed-run"), [
      "a-run",
      "b-run",
      "c-run",
    ]);
  });

  test("a corrupt or missing stored cursor reads as start-from-the-top", () => {
    assert.deepEqual(normalizeSchedulerCursor(undefined, "job"), {
      at: null,
      failures: {},
      updatedAt: null,
    });
    assert.equal(normalizeSchedulerCursor({ job: { at: "" } }, "job").at, null);
    assert.equal(normalizeSchedulerCursor({ job: { at: 7 } }, "job").at, null);
    assert.equal(normalizeSchedulerCursor({ other: { at: "x" } }, "job").at, null);
    assert.equal(normalizeSchedulerCursor({ job: { at: "r1" } }, "job").at, "r1");
  });

  test("the handler advances the cursor only over runs finished END TO END", () => {
    // A run interrupted part-way through must be rescanned from its first
    // group, or its later groups are never reached. The cursor is therefore
    // written from `lastFinished`, which is only assigned once the scan has
    // returned `complete` (or once the run has been stepped over for good).
    const handler = JOB.slice(JOB.indexOf("async function handler"));
    assert.match(handler, /if \(!result\.complete\) \{\s*\n\s*hasMore = true;/);
    assert.ok(
      handler.lastIndexOf("lastFinished = runId;") >
        handler.indexOf("if (!result.complete)"),
      "the cursor is advanced before the run is known to have finished",
    );
    assert.match(handler, /const nextCursor = nextScanCursor\(hasMore, lastFinished, cursor\.at\)/);
    assert.match(handler, /writeSchedulerCursor\(db, JOB_ID, nextCursor, failures\)/);
    // Written only when it MOVED. A tick every fifteen minutes over a term is
    // several thousand writes of the same value otherwise.
    assert.match(handler, /if \(nextCursor !== cursor\.at \|\| !sameFailures\(/);
  });

  test("the cursor is CLEARED at the end of the list and KEPT when nothing finished", () => {
    // Cleared when the queue ran out, so the next tick starts from the top
    // rather than sitting forever on the last run of the list.
    assert.equal(nextScanCursor(false, "b-run", "a-run"), null);
    assert.equal(nextScanCursor(false, null, "a-run"), null);
    // Stopped part-way, having finished something: that run.
    assert.equal(nextScanCursor(true, "b-run", "a-run"), "b-run");
    // Stopped part-way having finished NOTHING, which is what a tick entering
    // with a sliver of budget does. The cursor it came in with survives:
    // writing null would restart the whole list on every such tick and the
    // tail would never be reached.
    assert.equal(nextScanCursor(true, null, "a-run"), "a-run");
    assert.equal(nextScanCursor(true, null, null), null);
  });

  test("the read budget is the smaller of the job's own and the tick's", () => {
    // `maxFollowUpTasksPerTick` caps WRITES. A quiet week writes nothing at
    // all and still walks every run, every group and every session in the
    // band, so the scan needs a wall-clock bound of its own, floored by
    // whatever the tick has left.
    const handler = JOB.slice(JOB.indexOf("async function handler"));
    assert.match(
      handler,
      /Math\.min\(config\.unmarkedScanBudgetMs, ctx\.budget\.remainingMs\(\)\)/,
    );
    assert.match(
      handler,
      /Math\.min\(ctx\.maxPerTick, config\.maxFollowUpTasksPerTick\)/,
    );
    // Both bounds stop the scan mid-list rather than at the end of it, which
    // is what makes the next tick's resume worth having.
    assert.match(handler, /if \(Date\.now\(\) >= deadlineMs \|\| processed >= writeCap\)/);
    const scan = JOB.slice(
      JOB.indexOf("async function scanRun"),
      JOB.indexOf("async function handler"),
    );
    assert.match(scan, /return \{ processed, failed, complete: false \}/);
  });
});

// ===========================================================================
// The task id and the read-back
// ===========================================================================

describe("the follow-up task id", () => {
  const RUN = "ai-safety-pre-course__k3f9a2b1";
  const GROUP = "tuesday-group__7d2c";

  test("is the exact string the contract names", () => {
    assert.equal(
      registerFollowUpTaskId(RUN, GROUP, "w03"),
      "course-register__ai-safety-pre-course__k3f9a2b1__tuesday-group__7d2c__w03",
    );
  });

  test("a second session in one week gets its own id", () => {
    assert.notEqual(
      registerFollowUpTaskId(RUN, GROUP, "w03"),
      registerFollowUpTaskId(RUN, GROUP, "w03-2"),
    );
  });

  test("the fallback id is deterministic, not random", () => {
    // The marker is claimed before the write and stamped after it, so a crash
    // in between leaves a later tick re-deriving the same unit of work. A
    // random fallback would put a second card on the board every time.
    assert.equal(
      registerFollowUpFallbackTaskId(RUN, GROUP, "w03"),
      `${registerFollowUpTaskId(RUN, GROUP, "w03")}__alt`,
    );
    assert.equal(
      registerFollowUpFallbackTaskId(RUN, GROUP, "w03"),
      registerFollowUpFallbackTaskId(RUN, GROUP, "w03"),
    );
  });
});

describe("the ALREADY_EXISTS read-back", () => {
  const EXPECT = { runId: "run1", adminUids: ["admin1", "admin2"] };
  const ours = () => ({
    source: "course-register",
    sourceRef: { cohortId: "run1", groupId: "g1", sessionKey: "w03" },
    completerUids: ["admin1", "admin2"],
  });

  test("the tick's own task is recognised", () => {
    assert.equal(isOurFollowUpTask(ours(), EXPECT), true);
  });

  test("a document that has VANISHED is not ours (fail closed)", () => {
    // Essentially unreachable, and failing closed costs one extra card while
    // failing open hands a squatter a permanent silent suppression.
    assert.equal(isOurFollowUpTask(undefined, EXPECT), false);
  });

  test("a committee task squatting the id is refused on the SOURCE leg", () => {
    assert.equal(
      isOurFollowUpTask({ ...ours(), source: "committee" }, EXPECT),
      false,
    );
  });

  test("a personal task squatting the id is refused on the SOURCE leg", () => {
    assert.equal(
      isOurFollowUpTask({ ...ours(), source: "personal" }, EXPECT),
      false,
    );
  });

  test("the right source aimed at another cohort is refused on the POINTER leg", () => {
    assert.equal(
      isOurFollowUpTask(
        { ...ours(), sourceRef: { cohortId: "run2", groupId: "g1" } },
        EXPECT,
      ),
      false,
    );
    // And a task carrying the source with no pointer at all, which is the
    // ONLY shape a client can actually create: firestore.rules pins
    // `sourceRef` to null at create on both lanes.
    assert.equal(isOurFollowUpTask({ ...ours(), sourceRef: null }, EXPECT), false);
  });

  test("a task with no admin among its completers is refused on the THIRD leg", () => {
    assert.equal(
      isOurFollowUpTask({ ...ours(), completerUids: ["someone"] }, EXPECT),
      false,
    );
    assert.equal(
      isOurFollowUpTask({ ...ours(), completerUids: [] }, EXPECT),
      false,
    );
    assert.equal(isOurFollowUpTask({ ...ours(), completerUids: null }, EXPECT), false);
  });
});

// ===========================================================================
// The task payload
// ===========================================================================

describe("the follow-up task", () => {
  const NOW = hoursAfter(GRACE);
  const args = (overrides = {}) => ({
    runId: "run1",
    groupId: "g1",
    session: {
      weekNumber: 3,
      occurrence: 1,
      sessionKey: "w03",
      dateKey: "2026-09-29",
    },
    courseTitle: "AI Safety Fundamentals",
    groupName: "Tuesday group",
    adminUids: ["admin1", "admin2"],
    creatorUid: "admin1",
    dueDate: followUpDueAt(ENDED_AT, GRACE),
    now: NOW,
    limits: { title: 120, description: 4000 },
    ...overrides,
  });

  test("lands on the committee board, assigned to every admin", () => {
    const task = buildRegisterFollowUpTask(args());
    assert.equal(task.source, "course-register");
    assert.equal(task.visibility, "committee");
    assert.deepEqual(task.completerUids, ["admin1", "admin2"]);
    assert.equal(task.status, "todo");
    assert.equal(task.archived, false);
  });

  test("carries no reviewers", () => {
    // The contract's prose asks for the admins as reviewers too. The rules cap
    // `reviewerUids` at 5 while `completerUids` is capped at 10, so on a
    // committee of six admins a reviewer-mirrored task falls outside the band
    // every non-admin update path checks. A chase needs no signoff ritual
    // either: it is done when the register is pushed.
    assert.deepEqual(buildRegisterFollowUpTask(args()).reviewerUids, []);
  });

  test("is born already notified, so nothing emails about it", () => {
    // A job that emailed every admin per unmarked group per week would be
    // muted inside a fortnight, and the card is the point.
    const task = buildRegisterFollowUpTask(args());
    assert.equal(task.initialNotifyAt, NOW);
    assert.deepEqual(task.pendingNotifyUids, []);
  });

  test("is due at the session end plus the grace", () => {
    assert.equal(
      buildRegisterFollowUpTask(args()).dueDate.toISOString(),
      hoursAfter(GRACE).toISOString(),
    );
  });

  test("points at the run, the group and the session", () => {
    // The destroy sweep reads `cohortId`; the push's archive reads `groupId`
    // and `sessionKey`. Both find the card by DATA rather than by parsing a
    // doc id, which run and group slug ids make ambiguous.
    assert.deepEqual(buildRegisterFollowUpTask(args()).sourceRef, {
      cohortId: "run1",
      weekNumber: 3,
      groupId: "g1",
      sessionKey: "w03",
    });
  });

  test("survives `normalizeTask` unchanged, extra pointer keys included", () => {
    // A payload the reader drops fields from is a payload whose stats and
    // sweeps quietly describe something else.
    const task = buildRegisterFollowUpTask(args());
    const read = normalizeTask("course-register__run1__g1__w03", task);
    assert.equal(read.source, "course-register");
    assert.equal(read.visibility, "committee");
    assert.deepEqual(read.sourceRef, {
      cohortId: "run1",
      weekNumber: 3,
      groupId: "g1",
      sessionKey: "w03",
    });
    // ABSENT, not null, on a task that has no group: the tasks rules pin
    // `sourceRef` by equality on the committee update lane.
    const mirror = normalizeTask("m", { sourceRef: { cohortId: "r", weekNumber: 1 } });
    assert.deepEqual(mirror.sourceRef, { cohortId: "r", weekNumber: 1 });
    assert.equal("groupId" in mirror.sourceRef, false);
  });

  test("writes no undefined anywhere", () => {
    // Firestore refuses an undefined outright, and a job that throws on one
    // bad item is a job that stops chasing every group after it.
    for (const [key, value] of Object.entries(buildRegisterFollowUpTask(args()))) {
      assert.notEqual(value, undefined, `${key} is undefined`);
    }
  });

  test("the copy names the group, the course, the week and the date", () => {
    const task = buildRegisterFollowUpTask(args());
    assert.equal(task.title, "Unmarked register: Tuesday group, week 3");
    assert.match(task.description, /Tuesday group/);
    assert.match(task.description, /AI Safety Fundamentals/);
    assert.match(task.description, /Tuesday 29 September/);
    assert.match(task.description, /Push attendance/);
  });

  test("a half-authored run still produces readable copy", () => {
    // A group with no name and a run with no title is a legitimate state, and
    // a card reading "Unmarked register: , week 3" is worse than no card.
    const task = buildRegisterFollowUpTask(
      args({ groupName: "", courseTitle: "", session: {
        weekNumber: 3,
        occurrence: 1,
        sessionKey: "w03",
        dateKey: "",
      } }),
    );
    assert.equal(task.title, "Unmarked register: a group, week 3");
    assert.doesNotMatch(task.description, /undefined/);
    assert.match(task.description, /week 3/);
  });

  test("a second session in a week says which one it is", () => {
    const task = buildRegisterFollowUpTask(
      args({
        session: {
          weekNumber: 3,
          occurrence: 2,
          sessionKey: "w03-2",
          dateKey: "2026-10-01",
        },
      }),
    );
    assert.match(task.description, /session 2 of that week/);
  });

  test("the title is clamped to the tasks field limit", () => {
    const task = buildRegisterFollowUpTask(
      args({ groupName: "g".repeat(400), limits: { title: 120, description: 4000 } }),
    );
    assert.equal(task.title.length, 120);
  });

  test("a malformed date key degrades to no date rather than to a wrong one", () => {
    assert.equal(sessionDateLabel(""), "");
    assert.equal(sessionDateLabel("not-a-date"), "");
    assert.equal(sessionDateLabel("2026-09-29"), "Tuesday 29 September");
  });

  test("the copy helpers are pure functions of their arguments", () => {
    const copy = {
      courseTitle: "C",
      groupName: "G",
      weekNumber: 1,
      occurrence: 1,
      dateKey: "2026-09-29",
    };
    assert.equal(registerFollowUpTitle(copy), registerFollowUpTitle(copy));
    assert.equal(
      registerFollowUpDescription(copy),
      registerFollowUpDescription(copy),
    );
  });
});

// ===========================================================================
// Orderings that only the source can pin
// ===========================================================================

describe("the job's ordering", () => {
  test("the marker is CLAIMED before the task is minted and STAMPED after", () => {
    // Claim first turns a crash into a missed card, which the re-claim rule
    // recovers. The reverse turns it into a second card on every admin's
    // board, which nothing recovers.
    const raise = JOB.slice(
      JOB.indexOf("async function raiseFollowUp"),
      JOB.indexOf("async function createFollowUp"),
    );
    assert.ok(raise.length > 0, "raiseFollowUp is gone");
    const claimAt = raise.indexOf("await claim(db, marker");
    const buildAt = raise.indexOf("buildRegisterFollowUpTask({");
    const stampAt = raise.indexOf("await stampSent(db, marker.id");
    assert.ok(claimAt >= 0 && buildAt >= 0 && stampAt >= 0);
    assert.ok(claimAt < buildAt, "the task is built before the marker is claimed");
    assert.ok(buildAt < stampAt, "the marker is stamped before the task is minted");
    // A claim that is not taken does nothing at all.
    assert.match(raise, /if \(!outcome\.claimed\) return false;/);
  });

  test("a squat falls back to the second id and says so in the log", () => {
    const raise = JOB.slice(
      JOB.indexOf("async function raiseFollowUp"),
      JOB.indexOf("async function createFollowUp"),
    );
    assert.match(raise, /registerFollowUpFallbackTaskId\(/);
    assert.match(raise, /console\.warn\(/);
    // Nothing is overwritten and nothing is deleted: the only writes to
    // `tasks` in this job are creates.
    assert.doesNotMatch(JOB, /\.set\(payload/);
    assert.doesNotMatch(JOB, /collection\("tasks"\)[\s\S]{0,120}\.delete\(\)/);
  });

  test("both ids occupied leaves the marker UNSENT so the panel can see it", () => {
    const raise = JOB.slice(
      JOB.indexOf("async function raiseFollowUp"),
      JOB.indexOf("async function createFollowUp"),
    );
    const second = raise.slice(raise.indexOf("const second ="));
    assert.match(second, /stampError\(/);
    assert.match(second, /return false;/);
  });

  test("one bad item never stops the scan", () => {
    // A group with a corrupt calendar, a run whose document vanished, a task
    // id somebody has squatted: each is recorded and the scan carries on.
    assert.match(
      JOB,
      /if \(!runSnap\.exists\) return \{ processed, failed, complete: true \}/,
    );
    const scan = JOB.slice(
      JOB.indexOf("async function scanRun"),
      JOB.indexOf("async function handler"),
    );
    assert.match(scan, /} catch \(err\) \{[\s\S]{0,300}continue;/);
    // Every throwing call inside the scan is caught: the session resolve, the
    // one batched register read, and the claim-mint-stamp itself. An
    // unguarded `getAll` or `raiseFollowUp` would abandon the rest of the
    // run's groups on one bad group.
    assert.match(scan, /registers = await db\.getAll\(\.\.\.refs\);\s*\n\s*} catch/);
    assert.match(scan, /acted = await raiseFollowUp\(\{[\s\S]{0,600}?\n\s*} catch/);
  });

  test("...and a run that throws is CONTINUED past, not broken out of", () => {
    // `break` here would mean one poisoned run silences every run after it in
    // the list, which is the whole failure this job exists to remove.
    const handler = JOB.slice(JOB.indexOf("async function handler"));
    const start = handler.indexOf("result = await scanRun(db, ctx, runId, {");
    const runCatch = handler.slice(start, handler.indexOf("processed += result.processed;"));
    assert.ok(runCatch.includes("} catch (err) {"), "the run scan is not guarded");
    assert.match(runCatch, /continue;/);
    assert.doesNotMatch(runCatch, /break;/);
    // The failure is counted so a run that keeps throwing is eventually
    // stepped over rather than retried for the rest of the term.
    assert.match(runCatch, /failures\[runId\] = \(failures\[runId\] \?\? 0\) \+ 1;/);
    assert.match(handler, />= MAX_RUN_SCAN_FAILURES/);
    // CONSECUTIVE: a clean scan clears the count.
    assert.match(handler, /delete failures\[runId\];/);
  });

  test("the failure counts are pruned, compared and stored beside the cursor", () => {
    // Kept only for runs the job still lists, so the document does not grow a
    // key per run the platform has ever destroyed.
    assert.deepEqual(pruneFailures({ a: 2, gone: 1 }, ["a", "b"]), { a: 2 });
    assert.equal(sameFailures({ a: 1 }, { a: 1 }), true);
    assert.equal(sameFailures({ a: 1 }, { a: 2 }), false);
    assert.equal(sameFailures({ a: 1 }, {}), false);
    // A corrupt count reads as "not failing": the cost of that is a repeated
    // scan, and the cost of the opposite is a run nobody looks at again.
    assert.deepEqual(
      normalizeSchedulerCursor({ job: { at: "r1", failures: { a: "x", b: 0, c: 2 } } }, "job")
        .failures,
      { c: 2 },
    );
    assert.deepEqual(normalizeSchedulerCursor({ job: { at: "r1" } }, "job").failures, {});
  });

  test("a run with no admins raises nothing rather than an unassigned card", () => {
    const handler = JOB.slice(JOB.indexOf("async function handler"));
    assert.match(handler, /if \(adminUids\.length === 0\)/);
    assert.match(handler, /note: "no admins"/);
  });

  test("NO assertNotImpersonating: the tick is a bearer-token endpoint", () => {
    // The job is a module, not a route. There is no session and no actor to
    // impersonate; the gate is the tick endpoint's constant-time secret check,
    // which every job on the registry sits behind.
    assert.doesNotMatch(JOB, /assertNotImpersonating/);
    assert.match(
      source("app/api/scheduler/tick/route.ts"),
      /timingSafeEqual\(sha256\(presented\), sha256\(secret\)\)/,
    );
  });

  test("the scan reads only what it needs off the users collection", () => {
    // An admin's user document is the most PII-dense row this platform holds
    // and the job wants nothing from it but the id.
    const read = JOB.slice(JOB.indexOf("async function readAdminUids"));
    assert.match(read, /\.where\("role", "==", "admin"\)/);
    assert.match(read, /\.select\(\)/);
    // Capped at the tasks rules' own completer ceiling: a task with eleven
    // completers is one no SU-committee member could ever edit.
    assert.match(read, /TASK_FIELD_LIMITS\.maxCompleters/);
  });

  test("the run allowlist is every LIVE status, not `running` alone", () => {
    // The pre-course runs its six sessions while the admission round is still
    // open, so its run sits at `applications-open` throughout. Scanning
    // `running` only would miss the one cohort this job exists for.
    const list = JOB.slice(
      JOB.indexOf("const NUDGING_STATUSES"),
      JOB.indexOf("const MAX_CANDIDATE_RUNS"),
    );
    assert.match(list, /"applications-open"/);
    assert.match(list, /"applications-closed"/);
    assert.match(list, /"running"/);
    assert.doesNotMatch(list, /"draft"/);
    assert.doesNotMatch(list, /"completed"/);
    assert.doesNotMatch(list, /"cancelled"/);
  });
});

describe("the registry", () => {
  test("registration order is alphabetical by job id", () => {
    // Read the rule rather than a snapshot of today's list. Several PRs splice
    // into this one array in the same fortnight, so a pinned set of names is a
    // conflict on every one of them and says nothing about the property that
    // matters: the array is ordered by the ids the jobs carry, which is an
    // order every branch computes the same way. Identifier names are NOT that
    // order (unmarkedRegistersJob sorts after heartbeatJob while
    // courses-unmarked-registers sorts before heartbeat), so resolve each
    // entry to its real id before comparing.
    const table = REGISTRY.slice(REGISTRY.indexOf("export const JOBS"));
    const order = [...table.matchAll(/(\w+Job),/g)].map((m) => m[1]);
    assert.ok(order.includes("unmarkedRegistersJob"), "this job is not registered");

    const ids = order.map((name) => {
      const importLine = new RegExp(`import \\{ ${name} \\} from "([^"]+)"`).exec(REGISTRY);
      assert.ok(importLine, `${name} is in JOBS but never imported`);
      const jobSource = source(importLine[1].replace(/^\.\//, "lib/scheduler/") + ".ts");
      const id = /\bid: "([^"]+)",/.exec(jobSource);
      assert.ok(id, `${name} declares no id`);
      return id[1];
    });
    assert.deepEqual(ids, [...ids].sort(), `registration order is ${ids.join(", ")}`);
    assert.ok(ids.includes("courses-unmarked-registers"));
  });

  test("the job id is one the union already names", () => {
    assert.match(REGISTRY, /"courses-unmarked-registers",/);
    assert.match(JOB, /const JOB_ID = "courses-unmarked-registers";/);
    assert.match(JOB, /id: "courses-unmarked-registers",/);
  });

  test("the write cap is the contract's 25", () => {
    const block = JOB.slice(JOB.indexOf("export const unmarkedRegistersJob"));
    assert.match(block, /maxPerTick: 25,/);
  });
});

describe("the push closes the card", () => {
  test("the archive runs AFTER the transaction commits", () => {
    // Everything after the commit is best effort against a register that is
    // already locked and mirrors that are already correct. A create collision
    // inside a transaction aborts the whole transaction, so no write that can
    // collide may sit inside it.
    const commitAt = PUSH_ROUTE.indexOf("await db.runTransaction");
    const archiveAt = PUSH_ROUTE.indexOf("await archiveRegisterFollowUp(");
    assert.ok(commitAt >= 0 && archiveAt >= 0);
    assert.ok(commitAt < archiveAt, "the archive is inside or before the transaction");
  });

  test("...and BEFORE the already-pushed early return, so a second press cleans up", () => {
    const archiveAt = PUSH_ROUTE.indexOf("await archiveRegisterFollowUp(");
    const earlyReturnAt = PUSH_ROUTE.indexOf("if (alreadyPushed && !force)");
    assert.ok(earlyReturnAt >= 0);
    assert.ok(archiveAt < earlyReturnAt);
  });

  test("it costs no reads at all before the grace has passed", () => {
    // Which is the overwhelming majority of pushes: a register marked the
    // same evening cannot have a card.
    const fn = PUSH_ROUTE.slice(
      PUSH_ROUTE.indexOf("async function archiveRegisterFollowUp"),
      PUSH_ROUTE.indexOf("// POST"),
    );
    assert.ok(fn.length > 0, "archiveRegisterFollowUp is gone");
    const guardAt = fn.indexOf("followUpDueAt(endsAt, graceHours)");
    const firstReadAt = fn.indexOf("await primary.get()");
    assert.ok(guardAt >= 0 && firstReadAt >= 0);
    assert.ok(guardAt < firstReadAt, "the grace guard runs after the first read");
  });

  test("it finds the card by deterministic id AND by the pointer", () => {
    // The pointer query is what reaches a card that went to the fallback id
    // because a squatter held the deterministic one.
    const fn = PUSH_ROUTE.slice(
      PUSH_ROUTE.indexOf("async function archiveRegisterFollowUp"),
      PUSH_ROUTE.indexOf("// POST"),
    );
    assert.match(fn, /registerFollowUpTaskId\(runId, groupId, session\.sessionKey\)/);
    assert.match(fn, /\.where\("source", "==", REGISTER_FOLLOW_UP_TASK_SOURCE\)/);
    assert.match(fn, /\.where\("sourceRef\.groupId", "==", groupId\)/);
    assert.match(fn, /\.where\("sourceRef\.sessionKey", "==", session\.sessionKey\)/);
    // ARCHIVED, never deleted: the board hides archived tasks by default and
    // the chase stays on the record.
    assert.match(fn, /archived: true/);
    assert.doesNotMatch(fn, /\.delete\(\)/);
  });

  test("a failure here never undoes the lock or the mirrors", () => {
    const fn = PUSH_ROUTE.slice(
      PUSH_ROUTE.indexOf("async function archiveRegisterFollowUp"),
      PUSH_ROUTE.indexOf("// POST"),
    );
    assert.match(fn, /} catch \(err\) \{/);
    assert.match(fn, /console\.error\(/);
  });
});
