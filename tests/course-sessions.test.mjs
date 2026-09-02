/**
 * THE SESSION SEAM, `src/lib/courses/sessions.ts` and
 * `src/lib/courses/attendanceRollup.ts`, plus the source-level properties of
 * the two routes that own the push.
 *
 * Three things are pinned here, and each one is a thing that would be
 * expensive to discover in production:
 *
 *  1. REGISTER IDS ARE BYTE-IDENTICAL FOR OCCURRENCE 1. The whole
 *     occurrence dimension is built on that invariant: it is why nothing
 *     migrates, why account deletion's `documentId()` scan keeps working, and
 *     why a live cohort can take this deploy mid-term. The test names a real-
 *     looking run and asserts the exact string.
 *  2. THE ROLLUP'S DENOMINATOR. A cancelled session removed, a mid-run joiner
 *     scoped, an unmarked person in a pushed register counted absent. These
 *     are the numbers a reviewer reads and a completion bar is judged by, and
 *     each rule is one line of arithmetic away from being silently wrong.
 *  3. THE PUSH'S ORDERING. The marker `.create()` must sit AFTER the
 *     transaction commits (a create collision inside a transaction aborts the
 *     whole transaction, so the lock would depend on the mail), and
 *     `assertNotImpersonating()` must be the first thing every mutating
 *     handler does.
 *
 * Route handlers cannot be imported (`next/server`, `firebase-admin`), so (3)
 * is asserted at the SOURCE, exactly as `course-schedule-changes.test.mjs`
 * and `course-group-resolve.test.mjs` do.
 *
 * ## The loader dance
 *
 * Lifted from `course-group-resolve.test.mjs`. Same rules: nothing in `STUBS`
 * is reachable from an assertion here.
 */
import { test } from "node:test";
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

const { findSession, resolveSessions, sessionInstants, sessionKey } =
  await loadTs("lib/courses/sessions.ts");
const { recomputeRollup } = await loadTs("lib/courses/attendanceRollup.ts");
const { attendanceDocId, normalizeCourseAttendance } = await loadTs(
  "lib/firestore/courseAttendance.ts",
);
const { normalizeCourseGroup } = await loadTs("lib/firestore/courseGroups.ts");
const { weekDocId } = await loadTs("lib/firestore/courses.ts");

const source = (relativePath) => readFileSync(join(SRC, relativePath), "utf8");

const PUSH_ROUTE = "app/api/courses/groups/[groupId]/attendance/push/route.ts";
const REGISTER_ROUTE = "app/api/courses/groups/[groupId]/attendance/route.ts";
const NOTES_ROUTE = "app/api/courses/groups/[groupId]/participant-notes/route.ts";

// ---------------------------------------------------------------------------
// Fixtures, a real-looking run, group and plan
// ---------------------------------------------------------------------------

/** Six taught weeks with a reading week after week 3, the pre-course shape. */
function plan() {
  return [
    { kind: "week", weekNumber: 1, weekId: "w01" },
    { kind: "week", weekNumber: 2, weekId: "w02" },
    { kind: "week", weekNumber: 3, weekId: "w03" },
    { kind: "break", label: "Reading week" },
    { kind: "week", weekNumber: 4, weekId: "w04" },
    { kind: "week", weekNumber: 5, weekId: "w05" },
    { kind: "week", weekNumber: 6, weekId: "w06" },
  ];
}

function run(overrides = {}) {
  return {
    id: "ai-safety-pre-course__k3f9a2b1",
    startDate: "2026-09-21",
    weekPlan: plan(),
    ...overrides,
  };
}

/** Tuesdays 18:00, 90 minutes, in Hallward. A normalised group shape. */
function group(overrides = {}) {
  return normalizeCourseGroup("group-a__7d2c", {
    runId: "ai-safety-pre-course__k3f9a2b1",
    name: "Tuesday group",
    session: {
      weekday: 2,
      startTimeLocal: "18:00",
      durationMinutes: 90,
      location: "Hallward B12",
      meetingUrl: null,
      notes: "",
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// sessionKey and the id invariant
// ---------------------------------------------------------------------------

test("occurrence 1 IS the week doc id, byte for byte", () => {
  for (const n of [1, 3, 9, 10, 42, 60]) {
    assert.equal(sessionKey(n, 1), weekDocId(n));
    assert.equal(sessionKey(n), weekDocId(n), "the default occurrence is 1");
  }
});

test("a register id for occurrence 1 is unchanged for a real-looking run", () => {
  // The exact string a register written before the occurrence dimension
  // existed lives at. If this assertion ever has to be edited, every register
  // in the estate has to be migrated on the same deploy.
  assert.equal(
    attendanceDocId("ai-safety-pre-course__k3f9a2b1", "group-a__7d2c", 3),
    "ai-safety-pre-course__k3f9a2b1__group-a__7d2c__w03",
  );
  assert.equal(
    attendanceDocId("ai-safety-pre-course__k3f9a2b1", "group-a__7d2c", 3, 1),
    "ai-safety-pre-course__k3f9a2b1__group-a__7d2c__w03",
    "passing occurrence 1 explicitly must not change the id",
  );
});

test("occurrence 2 and up take a suffix no week can produce", () => {
  assert.equal(sessionKey(3, 2), "w03-2");
  assert.equal(sessionKey(12, 3), "w12-3");
  assert.equal(
    attendanceDocId("run__a", "grp__b", 3, 2),
    "run__a__grp__b__w03-2",
  );
  // The suffix must be free of the house id separator and of anything a URL
  // or a FieldPath would reinterpret.
  assert.doesNotMatch(sessionKey(3, 2), /[/.#]/);
});

test("a corrupt occurrence degrades to the first session rather than a new id", () => {
  assert.equal(sessionKey(3, 0), "w03");
  assert.equal(sessionKey(3, -4), "w03");
  assert.equal(sessionKey(3, 1.5), "w03", "a non-integer is not an occurrence");
});

// ---------------------------------------------------------------------------
// resolveSessions
// ---------------------------------------------------------------------------

test("one session per taught week, breaks excluded, in plan order", () => {
  const sessions = resolveSessions(run(), group());
  assert.deepEqual(
    sessions.map((s) => s.weekNumber),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(
    sessions.every((s) => s.occurrence === 1),
    "a group with no second slot holds one session a week",
  );
  assert.deepEqual(
    sessions.map((s) => s.sessionKey),
    ["w01", "w02", "w03", "w04", "w05", "w06"],
  );
});

test("the break shifts the weeks after it by a whole slot", () => {
  const sessions = resolveSessions(run(), group());
  const byWeek = new Map(sessions.map((s) => [s.weekNumber, s]));
  // 2026-09-21 is a Monday; the group meets Tuesdays.
  assert.equal(byWeek.get(1).slotStartKey, "2026-09-21");
  assert.equal(byWeek.get(1).dateKey, "2026-09-22");
  assert.equal(byWeek.get(3).dateKey, "2026-10-06");
  // Week 4 sits AFTER the reading week, so it is five slots in, not four.
  assert.equal(byWeek.get(4).slotStartKey, "2026-10-19");
  assert.equal(byWeek.get(4).dateKey, "2026-10-20");
});

test("a group's own pacing dates its own sessions", () => {
  const paced = group({ paceStartDate: "2026-09-28" });
  const sessions = resolveSessions(run(), paced);
  assert.equal(sessions[0].slotStartKey, "2026-09-28");
  assert.equal(sessions[0].dateKey, "2026-09-29");
});

test("a week override moves the FIRST session of that week only", () => {
  const moved = group({
    sessionOverrides: {
      w02: { weekday: 4, startTimeLocal: "17:00", location: "Trent B7" },
    },
  });
  const sessions = resolveSessions(run(), moved);
  const week2 = findSession(sessions, 2, 1);
  assert.equal(week2.session.weekday, 4);
  assert.equal(week2.session.startTimeLocal, "17:00");
  assert.equal(week2.dateKey, "2026-10-01", "Thursday of week 2's slot");
  assert.equal(
    findSession(sessions, 3, 1).session.startTimeLocal,
    "18:00",
    "every other week keeps the standing slot",
  );
});

test("a half-authored run yields its sessions with no dates rather than none", () => {
  const sessions = resolveSessions(run({ startDate: "" }), group());
  assert.equal(sessions.length, 6, "the register still has its columns");
  assert.ok(sessions.every((s) => s.dateKey === "" && s.slotStartKey === ""));
  assert.deepEqual(sessionInstants(sessions[0]), { startsAt: null, endsAt: null });
});

test("a second slot on the group yields a second session, keyed apart", () => {
  // `extraSession` is not written by `normalizeCourseGroup` yet (the cadence
  // decision is the owner's), so the resolver reads it optionally. This is
  // the shape it will resolve the day the field lands.
  const twice = {
    ...group(),
    extraSession: {
      weekday: 5,
      startTimeLocal: "14:00",
      durationMinutes: 60,
      location: "Online",
      meetingUrl: null,
      notes: "",
    },
  };
  const sessions = resolveSessions(run(), twice);
  assert.equal(sessions.length, 12, "two sessions per taught week");
  assert.deepEqual(
    sessions.slice(0, 4).map((s) => s.sessionKey),
    ["w01", "w01-2", "w02", "w02-2"],
    "the pair sits together, first session first",
  );
  const second = findSession(sessions, 1, 2);
  assert.equal(second.dateKey, "2026-09-25", "the Friday of week 1's slot");
  assert.equal(second.weekId, "w01", "both sessions belong to the same week doc");
});

test("a second slot with no usable time is not a session", () => {
  const broken = { ...group(), extraSession: { weekday: 5, startTimeLocal: "" } };
  assert.equal(resolveSessions(run(), broken).length, 6);
});

test("a plan with a duplicate or out-of-range week is defended against", () => {
  const corrupt = run({
    weekPlan: [
      { kind: "week", weekNumber: 1, weekId: "w01" },
      { kind: "week", weekNumber: 1, weekId: "w01" },
      { kind: "week", weekNumber: 0, weekId: "w00" },
      { kind: "week", weekNumber: 61, weekId: "w61" },
      { kind: "week", weekNumber: 2, weekId: "w02" },
    ],
  });
  assert.deepEqual(
    resolveSessions(corrupt, group()).map((s) => s.weekNumber),
    [1, 2],
  );
});

test("sessionInstants spans the session's own duration", () => {
  const first = resolveSessions(run(), group())[0];
  const { startsAt, endsAt } = sessionInstants(first);
  // 2026-09-22 18:00 London is BST, so 17:00Z.
  assert.equal(startsAt.toISOString(), "2026-09-22T17:00:00.000Z");
  assert.equal(endsAt.toISOString(), "2026-09-22T18:30:00.000Z");
});

test("an unplaced caller resolves the run's weeks with no session times", () => {
  const sessions = resolveSessions(run(), null);
  assert.equal(sessions.length, 6);
  assert.ok(sessions.every((s) => s.dateKey === ""));
});

// ---------------------------------------------------------------------------
// normalizeCourseAttendance
// ---------------------------------------------------------------------------

test("a register with no occurrence field is the week's first session", () => {
  const doc = normalizeCourseAttendance("run__grp__w03", {
    runId: "run",
    groupId: "grp",
    weekNumber: 3,
    records: { u1: "present" },
  });
  assert.equal(doc.occurrence, 1);
  assert.equal(doc.sessionKey, "w03");
  assert.equal(doc.held, true, "a register written before `held` existed counts");
});

test("the session key is derived, never taken from the document", () => {
  const doc = normalizeCourseAttendance("run__grp__w03-2", {
    runId: "run",
    groupId: "grp",
    weekNumber: 3,
    occurrence: 2,
    // A hand-edited document claiming to be a different session.
    sessionKey: "w99",
  });
  assert.equal(doc.sessionKey, "w03-2");
});

// ---------------------------------------------------------------------------
// recomputeRollup
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-20T20:00:00Z");
const PUSHED = new Date("2026-10-06T20:00:00Z");

function register(weekNumber, status, extra = {}) {
  return {
    sessionKey: sessionKey(weekNumber, extra.occurrence ?? 1),
    weekNumber,
    occurrence: extra.occurrence ?? 1,
    held: extra.held ?? true,
    pushedAt: "pushedAt" in extra ? extra.pushedAt : PUSHED,
    status,
  };
}

test("the five states each land in their own count", () => {
  const rollup = recomputeRollup(
    [
      register(1, "present"),
      register(2, "late"),
      register(3, "left-early"),
      register(4, "absent"),
      register(5, "excused"),
    ],
    { joinedWeekNumber: 1, now: NOW },
  );
  assert.deepEqual(rollup, {
    sessionsHeld: 5,
    attendedInFull: 1,
    late: 1,
    leftEarly: 1,
    absent: 1,
    excused: 1,
    lastPushedSessionKey: "w05",
    lastComputedAt: NOW,
  });
});

test("a session that was not held leaves every denominator", () => {
  const rollup = recomputeRollup(
    [
      register(1, "present"),
      // Cancelled. Nobody could have attended, and nobody is marked absent
      // for it, the whole point of the held switch.
      register(2, null, { held: false }),
      register(3, "present"),
    ],
    { joinedWeekNumber: 1, now: NOW },
  );
  assert.equal(rollup.sessionsHeld, 2);
  assert.equal(rollup.absent, 0);
  assert.equal(rollup.attendedInFull, 2);
  assert.equal(rollup.lastPushedSessionKey, "w03");
});

test("an unpushed register counts for nothing at all", () => {
  const rollup = recomputeRollup(
    [register(1, "present"), register(2, "present", { pushedAt: null })],
    { joinedWeekNumber: 1, now: NOW },
  );
  assert.equal(rollup.sessionsHeld, 1);
  assert.equal(
    rollup.lastPushedSessionKey,
    "w01",
    "a draft register cannot be the last pushed session",
  );
});

test("an unmarked person in a pushed, held register is absent", () => {
  const rollup = recomputeRollup([register(1, null), register(2, "present")], {
    joinedWeekNumber: 1,
    now: NOW,
  });
  assert.equal(rollup.absent, 1);
  assert.equal(rollup.sessionsHeld, 2);
});

test("sessions before the member joined are not theirs to have missed", () => {
  const rollup = recomputeRollup(
    [
      register(1, null),
      register(2, null),
      register(3, "present"),
      register(4, "absent"),
    ],
    { joinedWeekNumber: 3, now: NOW },
  );
  assert.equal(rollup.sessionsHeld, 2, "only the sessions from week 3");
  assert.equal(rollup.absent, 1);
  assert.equal(rollup.attendedInFull, 1);
});

test("a member who joined before a held, unpushed session has nothing yet", () => {
  const rollup = recomputeRollup([register(1, null, { pushedAt: null })], {
    joinedWeekNumber: 1,
    now: NOW,
  });
  assert.equal(rollup.sessionsHeld, 0);
  assert.equal(rollup.lastPushedSessionKey, null);
  assert.equal(rollup.lastComputedAt, NOW, "the recompute still happened");
});

test("the last pushed session is the furthest through the COURSE, not the latest push", () => {
  // Week 2 was pushed late, after week 3. The figures still reach week 3.
  const rollup = recomputeRollup(
    [
      register(3, "present", { pushedAt: new Date("2026-10-06T20:00:00Z") }),
      register(2, "present", { pushedAt: new Date("2026-10-13T09:00:00Z") }),
    ],
    { joinedWeekNumber: 1, now: NOW },
  );
  assert.equal(rollup.lastPushedSessionKey, "w03");
});

test("two sessions in one week are two sessions in the rollup", () => {
  const rollup = recomputeRollup(
    [
      register(1, "present"),
      register(1, "absent", { occurrence: 2 }),
      register(2, "present"),
    ],
    { joinedWeekNumber: 1, now: NOW },
  );
  assert.equal(rollup.sessionsHeld, 3);
  assert.equal(rollup.absent, 1);
  assert.equal(rollup.lastPushedSessionKey, "w02");
});

test("the recompute is order-independent", () => {
  const rows = [
    register(1, "present"),
    register(2, "absent"),
    register(3, "excused"),
    register(4, "late"),
  ];
  const forwards = recomputeRollup(rows, { joinedWeekNumber: 1, now: NOW });
  const backwards = recomputeRollup([...rows].reverse(), {
    joinedWeekNumber: 1,
    now: NOW,
  });
  assert.deepEqual(forwards, backwards);
});

// ---------------------------------------------------------------------------
// Route ordering, asserted at the source (see the header)
// ---------------------------------------------------------------------------

test("every mutating handler in the register tree guards view-as FIRST", () => {
  for (const route of [PUSH_ROUTE, REGISTER_ROUTE, NOTES_ROUTE]) {
    const text = source(route);
    for (const method of ["POST", "PATCH"]) {
      const at = text.indexOf(`export async function ${method}(`);
      if (at < 0) continue;
      const head = text.slice(at, at + 400);
      assert.match(
        head,
        /assertNotImpersonating\(\)/,
        `${route} ${method} must refuse during a view-as session before it does anything else`,
      );
    }
  }
});

test("the push claims its send marker AFTER the transaction commits", () => {
  const text = source(PUSH_ROUTE);
  // The CODE, not the prose: the module header names `.create()` in a
  // sentence, and an index that matched a comment would pass on a route that
  // did the wrong thing.
  const transaction = text.indexOf("await db.runTransaction(");
  const create = text.indexOf("await markerRef.create({");
  assert.ok(transaction > 0, "the push locks the register in a transaction");
  assert.ok(create > 0, "the push claims the gnudge marker with a standalone create");
  assert.ok(
    create > transaction,
    "a .create() collision inside a transaction aborts the WHOLE transaction, " +
      "so the register lock would depend on whether the email marker was free. " +
      "The claim must be a standalone create after the commit.",
  );
  assert.doesNotMatch(
    text.slice(transaction, create),
    /tx\.create\(/,
    "nothing inside the transaction may create a document",
  );
});

test("the push recomputes the rollup rather than incrementing it", () => {
  assert.match(
    source(PUSH_ROUTE),
    /readMirrorPlan\(/,
    "the rollup comes from the shared mirror helper, not from arithmetic here",
  );
  assert.match(
    source("lib/courses/attendanceMirror.ts"),
    /recomputeRollup\(/,
    "and that helper recomputes from the registers it just read",
  );
  for (const file of [PUSH_ROUTE, "lib/courses/attendanceMirror.ts"]) {
    assert.doesNotMatch(
      source(file),
      /FieldValue\.increment\(/,
      "the attendance rollup is a FULL RECOMPUTE, never a delta: the direct " +
        "lesson from applicationCounts drift",
    );
  }
});

test("a post-push edit is admin-only and writes an audit row per changed mark", () => {
  const text = source(REGISTER_ROUTE);
  assert.match(text, /export async function PATCH\(/);
  assert.match(text, /COURSE_AUDIT_COLLECTION/);
  assert.match(text, /"attendance-edit"/);
});
