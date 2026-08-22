/**
 * Unit tests for WHAT HAPPENS WHEN A COURSE RUN'S SCHEDULE IS EDITED AFTER
 * DATA EXISTS — the class of bug the P0–P11 suites leave at zero coverage.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * `tests/week-plan.test.mjs` pins `currentWeekFor` as a pure function and
 * `tests/course-task-mirror.test.mjs` pins id determinism. Both test the inputs
 * going IN. Nothing tested what happens when an admin moves `startDate`,
 * reorders the week plan, removes a taught week, archives a group, or walks a
 * run's status forward — after members have already read weeks, been mailed,
 * been marked present, and had cards mirrored onto their board.
 *
 * A schedule-change audit found two systemic causes under almost every finding:
 *
 *  1. **TWO WEEK-ADDRESSING DOCTRINES.** `WeekPlanBuilder.renumber()` preserves
 *     each entry's `weekId` and reassigns `weekNumber`, and says outright that
 *     the two may legitimately disagree. Every member-facing reader ignores the
 *     plan's `weekId` and addresses `weekDocId(weekNumber)`. So the field the
 *     builder protects is the one almost nobody reads, and a reorder permutes
 *     the curriculum members see away from the one the admin arranged.
 *  2. **SNAPSHOTS TAKEN ONCE, NEVER RE-DERIVED.** `joinedWeekNumber`,
 *     `lastTaskSyncedWeek`, `courseAttendance.sessionAt`, an application's
 *     frozen `availability` string, and the `{startDate}` inside an already-sent
 *     acceptance email are each computed from the schedule at one instant.
 *     Moving the schedule moves reality but not any of them.
 *
 * ## Two kinds of test in here, labelled
 *
 * **GUARD** — a property the code really holds. Remove the guard and the test
 * goes red. These are the ones that earn their keep on every future edit.
 *
 * **PROVEN GAP** — the audit found a hole, and closing it needs a product
 * decision rather than a patch. Following the precedent set by
 * `scripts/rules-tests/tests/candidate-findings.test.mjs`, these assert that the
 * hole is STILL THERE, so they fail the day someone closes it. That is
 * deliberate: **when you fix one, invert the assertion in the same commit.**
 * Each carries the decision the owner has to make. A gap nobody has written
 * down is a gap that gets re-discovered; a gap with a failing-on-fix test is a
 * decision with a deadline.
 *
 * ## The loader dance
 *
 * Lifted from `course-nudge.test.mjs`, which already solved importing TypeScript
 * from `.mjs` on this repo's Node (v20, no native type stripping) INCLUDING
 * `@/…` alias resolution and stubbing `server-only`. Same rules apply: nothing
 * in `STUBS` is reachable from an assertion here, and no test in this file may
 * ever put mail on the wire.
 *
 * Route handlers cannot be imported at all (`next/server`, `firebase-admin`),
 * so route-level properties are asserted at the SOURCE, exactly as the nudge
 * suite does for the marker ordering. That is not a weaker test — it is the
 * only thing standing between a pure model in here and a route that no longer
 * matches it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/** See `course-nudge.test.mjs` — nothing here is reachable from an assertion. */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    join(SRC, "emails", "CourseNudgeEmail.tsx"),
    "export default function CourseNudgeEmail() {\n" +
      "  throw new Error('CourseNudgeEmail is stubbed in tests');\n}",
  ],
  [
    join(SRC, "lib", "email", "send.ts"),
    "export function sendEmail() {\n" +
      "  throw new Error('sendEmail is stubbed in tests — a unit test must not send mail');\n}",
  ],
]);

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
        "the `typescript` devDependency is not installed — run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const { addDaysToKey, currentWeekFor, isValidDateKey } = await loadTs(
  "lib/courses/weekPlan.ts",
);
const { normalizeCourseRun, sanitizeWeekPlan, weekDocId } = await loadTs(
  "lib/firestore/courses.ts",
);
const { GROUP_FIELD_LIMITS, normalizeCourseGroup, sessionForWeek } = await loadTs(
  "lib/firestore/courseGroups.ts",
);
const { attendanceDocId } = await loadTs("lib/firestore/courseAttendance.ts");
const { ENROLMENT_STATUSES, courseEnrolmentId, normalizeCourseEnrolment } =
  await loadTs("lib/firestore/courseEnrolments.ts");
const { courseTaskId } = await loadTs("lib/firestore/courseTasks.ts");
const {
  buildCourseNudgeTokens,
  nudgeMarkerId,
  nudgeWeekMarkerIds,
  renderCourseNudge,
} = await loadTs("lib/email/courseNudgeEmail.ts");
const { courseTemplateDefaults } = await loadTs("lib/firestore/courseEmails.ts");

// ---------------------------------------------------------------------------
// Source handles. Every route-level property below is asserted against one of
// these, because none of them is importable (next/server, firebase-admin).
// ---------------------------------------------------------------------------

const src = (...parts) => readFileSync(join(SRC, ...parts), "utf8");
const api = (...parts) => src("app", "api", "courses", ...parts);

const NUDGE = api("runs", "[runId]", "nudge", "route.ts");
const SYNC_TASKS = api("runs", "[runId]", "sync-tasks", "route.ts");
const OVERVIEW = api("runs", "[runId]", "overview", "route.ts");
const ME = api("me", "route.ts");
const ATTENDANCE = api("groups", "[groupId]", "attendance", "route.ts");
const GROUP_EXERCISES = api("groups", "[groupId]", "exercises", "route.ts");
const MY_EXERCISES = api("runs", "[runId]", "my-exercises", "route.ts");
const SUBMIT = api("runs", "[runId]", "exercises", "[exerciseId]", "submit", "route.ts");
const ALLOCATE = api("runs", "[runId]", "allocate", "route.ts");
const ALLOCATION = api("runs", "[runId]", "allocation", "route.ts");
const ALLOCATION_PUBLISH = api("runs", "[runId]", "allocation", "publish", "route.ts");
const DECIDE = api("runs", "[runId]", "applications", "[uid]", "decide", "route.ts");
const APPLY_ROUTE = api("runs", "[runId]", "apply", "route.ts");
const STATUS_ROUTE = api("runs", "[runId]", "status", "route.ts");
const REMOVE_ROUTE = api("runs", "[runId]", "enrolments", "[uid]", "remove", "route.ts");
const FACILITATORS = api("groups", "[groupId]", "facilitators", "route.ts");

const WEEK_PLAN_BUILDER = src("features", "courses", "WeekPlanBuilder.tsx");
const WEEK_VIEW = src("features", "courses", "WeekView.tsx");
const PROGRESS_BODY = src("app", "(app)", "learn", "[runId]", "progress", "ProgressBody.tsx");
const GROUP_PAGE = src("app", "(app)", "learn", "[runId]", "group", "[groupId]", "page.tsx");
const RUN_LAYOUT = src("app", "(app)", "learn", "[runId]", "layout.tsx");
const MY_COURSES_SUMMARY = src("features", "courses", "MyCoursesSummary.tsx");
const COURSE_CTA = src("features", "courses", "CourseCTA.tsx");
const APPLY_FORM = src("features", "courses", "ApplyForm.tsx");
const FETCH_COURSES = src("features", "courses", "fetchCourses.ts");
const COURSE_MUTATIONS = src("features", "courses", "courseMutations.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Monday, so every slot below starts on a Monday. */
const START = "2026-09-28";

const week = (n) => ({ kind: "week", weekNumber: n, weekId: weekDocId(n) });
const brk = (label) => ({ kind: "break", label });

/** `n` consecutive taught weeks, the shape a freshly-built plan has. */
const plainPlan = (n) => Array.from({ length: n }, (_, i) => week(i + 1));

const run = (overrides = {}) => ({
  startDate: START,
  weekPlan: plainPlan(8),
  ...overrides,
});

/** Noon on the `d`th day of the run (day 0 = the start date). */
function dayOfRun(d, startDate = START) {
  return new Date(`${addDaysToKey(startDate, d)}T12:00:00Z`);
}

// ===========================================================================
// CAUSE 1 — ONE WEEK-ADDRESSING DOCTRINE
//
// `weekDocId(weekNumber)` is the address every member-facing surface resolves.
// The plan entry's own `weekId` is a second, editable spelling of the same
// thing, and the two can be made to disagree from the admin UI.
// ===========================================================================

/**
 * `WeekPlanBuilder.renumber()`, reproduced. Pinned to the real one by the source
 * assertion immediately below, so this cannot quietly become a model of code
 * that no longer exists.
 */
function renumber(plan) {
  let n = 0;
  return plan.map((entry) => {
    if (entry.kind !== "week") return entry;
    n += 1;
    return { kind: "week", weekNumber: n, weekId: entry.weekId };
  });
}

/** True when every taught entry addresses the doc its own number resolves to. */
function planIsCanonicallyAddressed(plan) {
  return plan.every((e) => e.kind !== "week" || e.weekId === weekDocId(e.weekNumber));
}

test("GUARD — renumber() renumbers positionally and preserves weekId", () => {
  // The builder's stated contract, and the whole reason the two doctrines can
  // diverge. If this ever changes, every assertion in this section is about a
  // different program.
  assert.match(WEEK_PLAN_BUILDER, /function renumber\(plan: WeekPlanEntry\[\]\)/);
  assert.match(WEEK_PLAN_BUILDER, /return \{ kind: "week", weekNumber: n, weekId: entry\.weekId \}/);
  assert.match(WEEK_PLAN_BUILDER, /`weekId` is deliberately NOT recomputed/);
  // …and it is applied after EVERY mutation, which is what makes a reorder a
  // renumber rather than a swap of two labels.
  assert.match(WEEK_PLAN_BUILDER, /function mutate\(next: WeekPlanEntry\[\]\) \{\s*setPlan\(renumber\(next\)\);/);

  const plan = renumber([week(3), week(1), week(2)]);
  assert.deepEqual(
    plan.map((e) => e.weekNumber),
    [1, 2, 3],
  );
  assert.deepEqual(
    plan.map((e) => e.weekId),
    ["w03", "w01", "w02"],
  );
});

test("GUARD — a plan that has never been reordered is canonically addressed", () => {
  // The premise of every reader below. Adding weeks and breaks at the END, and
  // labelling breaks, all keep the two spellings in agreement — which is why
  // the divergence is invisible until someone presses ▲.
  assert.ok(planIsCanonicallyAddressed(renumber(plainPlan(8))));
  assert.ok(planIsCanonicallyAddressed(renumber([...plainPlan(3), brk("Reading week")])));
  assert.ok(
    planIsCanonicallyAddressed(
      renumber([...plainPlan(4), { kind: "week", weekNumber: 0, weekId: "w05" }]),
    ),
  );
});

test("PROVEN GAP — one press of ▲ permutes the curriculum the cohort reads", () => {
  // The exact sequence from the audit: add a week (it takes the lowest free id,
  // w05) then move it to position 2.
  const added = renumber([...plainPlan(4), { kind: "week", weekNumber: 0, weekId: "w05" }]);
  const moved = renumber([added[0], added[4], added[1], added[2], added[3]]);

  // The admin's arrangement: slot 2 is the week they just wrote (w05).
  assert.equal(moved[1].weekNumber, 2);
  assert.equal(moved[1].weekId, "w05");

  // What the cohort gets: /learn/{run}/weeks/2 resolves weekDocId(2) = "w02",
  // which is now the plan's week 3. Every week from 2 on is off by one.
  assert.notEqual(weekDocId(moved[1].weekNumber), moved[1].weekId);
  assert.equal(planIsCanonicallyAddressed(moved), false);

  // …and the drift is not one week's worth. Four of the five entries now point
  // at a document other than the one the admin put in that position.
  const drifted = moved.filter((e) => e.weekId !== weekDocId(e.weekNumber));
  assert.equal(drifted.length, 4);

  // WHEN YOU FIX THIS, invert the two assertions above. The two candidate
  // fixes are a product decision, not a patch:
  //   (a) renumber() recomputes weekId — the plan becomes canonical, and the
  //       authored curriculum + everyone's saved progress REPOINT to different
  //       weeks (which is the harm the current comment exists to prevent); or
  //   (b) every reader honours the plan's weekId — six member-facing call
  //       sites change, `attendanceDocId` and `courseTaskId` stop being
  //       derivable from a number, and `/weeks/{n}` needs the plan to resolve.
  // Either is defensible. Neither is guessable from the code.
});

test("GUARD — every member-facing surface addresses a week by weekDocId(number)", () => {
  // Six readers, one doctrine. This is the assertion that keeps a seventh from
  // being written against the plan's `weekId` by accident.
  const readers = [
    [WEEK_VIEW, /useWeek\(runId, weekDocId\(weekNumber\)/],
    [NUDGE, /const weekId = weekDocId\(weekNumber\);/],
    [SYNC_TASKS, /\.doc\(weekDocId\(weekNumber\)\)/],
    [OVERVIEW, /return n >= 1 \? weekDocId\(n\) : "";/],
    [GROUP_PAGE, /sessionForWeek\(group, weekNumber >= 1 \? weekDocId\(weekNumber\) : ""\)/],
    [GROUP_EXERCISES, /const weekId = weekDocId\(week\);/],
  ];
  for (const [source, pattern] of readers) {
    assert.match(source, pattern);
  }
  // The register id too, so a week's attendance and a week's page cannot end up
  // addressed by two different keys.
  assert.equal(attendanceDocId("run1", "grp1", 3), "run1__grp1__w03");
  assert.equal(courseTaskId("run1", 3, "u1").split("__")[0], `course-${weekDocId(3)}`);
});

test("PROVEN GAP — exactly two readers still honour the plan entry's own weekId", () => {
  // The minority doctrine, named so it cannot grow. Both pass a PLAN ENTRY's
  // `weekId` into `sessionForWeek`, whose keys are otherwise written by
  // `weekDocId(n)` everywhere else — so on a reordered plan a one-week room or
  // time change shows on the member's session card and NOT in the register, or
  // the other way round.
  //
  // This assertion is a SUBSET test: fixing either outlier keeps it green,
  // adding a third turns it red.
  const known = new Map([
    ["attendance/route.ts", [ATTENDANCE, /sessionForWeek\(group, week\.weekId\)/]],
    ["allocation/publish/route.ts", [ALLOCATION_PUBLISH, /firstWeek\.kind === "week" \? firstWeek\.weekId/]],
  ]);
  const stillDivergent = [...known]
    .filter(([, [source, pattern]]) => pattern.test(source))
    .map(([name]) => name);
  assert.deepEqual(stillDivergent.sort(), [
    "allocation/publish/route.ts",
    "attendance/route.ts",
  ]);

  // The tell that attendance is internally inconsistent rather than merely
  // choosing the other doctrine: ONE function resolves the override by the plan
  // entry's weekId while the register beside it is addressed by NUMBER.
  assert.match(ATTENDANCE, /attendanceDocId\(runId, groupId, weekNumber\)/);

  // THE FIX, if the owner takes doctrine (a): pass `weekDocId(week.weekNumber)`
  // in `sessionInstantFor`, and `weekDocId(1)`-from-the-plan-index in
  // `firstSessionWhen`. Then delete this test.
});

test("PROVEN GAP — a reordered plan makes sessionForWeek return another week's override", () => {
  // The consequence, with the real merge function and the real normaliser: an
  // override written for the week the member sees as week 2 is keyed "w02",
  // while attendance looks it up under the plan entry's id "w05".
  const group = normalizeCourseGroup("grp1", {
    runId: "run1",
    name: "Group A",
    session: {
      weekday: 2,
      startTimeLocal: "18:00",
      durationMinutes: 90,
      location: "Hallward B12",
      meetingUrl: null,
      notes: "",
    },
    sessionOverrides: { w02: { location: "Monica Partridge A11", startTimeLocal: "19:00" } },
  });

  const added = renumber([...plainPlan(4), { kind: "week", weekNumber: 0, weekId: "w05" }]);
  const moved = renumber([added[0], added[4], added[1], added[2], added[3]]);
  const planEntry = moved[1];

  // The member's session card (overview / group page) — the override applies.
  assert.equal(sessionForWeek(group, weekDocId(planEntry.weekNumber)).location, "Monica Partridge A11");
  // The register's `sessionAt` (attendance) — it does not.
  assert.equal(sessionForWeek(group, planEntry.weekId).location, "Hallward B12");
  assert.equal(sessionForWeek(group, planEntry.weekId).startTimeLocal, "18:00");
});

test("GUARD — sessionOverrides is capped at 20 keys, dead keys included", () => {
  // A key whose week has left the plan is a DEAD key that still occupies the
  // budget, and the normaliser truncates by insertion order rather than by
  // liveness — so twenty stale weeks can crowd out the one override that
  // matters. The cap itself is the guard; that it counts dead keys is the gap.
  const overrides = {};
  for (let n = 1; n <= 25; n += 1) overrides[weekDocId(n)] = { location: `Room ${n}` };
  const group = normalizeCourseGroup("grp1", { runId: "run1", sessionOverrides: overrides });

  assert.equal(Object.keys(group.sessionOverrides).length, GROUP_FIELD_LIMITS.maxSessionOverrides);
  assert.equal(GROUP_FIELD_LIMITS.maxSessionOverrides, 20);
  // The 21st key onward is silently dropped: a live week can lose its override
  // to twenty dead ones with no error anywhere.
  assert.equal(group.sessionOverrides[weekDocId(21)], undefined);
  assert.equal(group.sessionOverrides[weekDocId(20)].location, "Room 20");
  // And the client mutation truncates the same way, so the two agree.
  assert.match(COURSE_MUTATIONS, /GROUP_FIELD_LIMITS\.maxSessionOverrides/);
});

test("PROVEN GAP — a week doc's stored weekNumber is never re-synced after a renumber", () => {
  // Three-way drift with no reconciler: the plan says one thing, the doc's own
  // `weekNumber` field says another, and `weekDocId(n)` addresses a third.
  assert.match(COURSE_MUTATIONS, /weekNumber/);
  assert.match(
    COURSE_MUTATIONS,
    /so the editor can reconcile a doc whose number has drifted/,
  );
  // Nothing anywhere re-stamps a week doc's number when the plan is saved: the
  // week-plan save writes ONLY `weekPlan`.
  assert.match(WEEK_PLAN_BUILDER, /await updateRun\(runId, \{ weekPlan: plan \}\)/);
  assert.doesNotMatch(WEEK_PLAN_BUILDER, /ensureWeekDoc|saveWeek/);
  // The overview's week index labels and sorts by the STORED field while the
  // link it renders resolves `weekDocId(number)` — so a row can count doc A's
  // items and link to doc B.
  assert.match(OVERVIEW, /\.sort\(\(a, b\) => a\.weekNumber - b\.weekNumber/);
  assert.match(PROGRESS_BODY, /byWeek\.get\(week\.weekNumber\)/);
});

// ===========================================================================
// CAUSE 2 — SNAPSHOTS
//
// The high-water mark is the one snapshot with a real invariant attached
// ("DISMISSAL STICKS"), and it is the one this suite can hold to it.
// ===========================================================================

/**
 * The sync route's short-circuit, reproduced. Pinned to the real one below.
 * `mark` is `courseEnrolments.lastTaskSyncedWeek`, absent on a fresh enrolment.
 */
const alreadyDelivered = (mark, anchor) => (mark ?? 0) >= anchor;

test("GUARD — the task mirror's high-water mark only ever moves FORWARD", () => {
  // THE dismissal guarantee. `sync-tasks` only ever `.create()`s, and firestore
  // rules let a member DELETE their own mirror. The mark is the entire reason a
  // dismissed card stays dismissed — and the anchor it is compared against is
  // recomputed from the run's dates on every single mount, by an admin-editable
  // `startDate` and an admin-editable `weekPlan`.
  assert.match(
    SYNC_TASKS,
    /if \(\(enrolment\.lastTaskSyncedWeek \?\? 0\) >= weekNumber\) \{/,
    "the short-circuit is no longer a >= against the high-water mark",
  );
  assert.match(SYNC_TASKS, /DISMISSAL STICKS/);
  // The mirror is still a one-way projection: no update, no delete, create only.
  assert.match(SYNC_TASKS, /await taskRef\.create\(payload\)/);
  assert.doesNotMatch(SYNC_TASKS, /taskRef\.(update|delete|set)\(/);
});

test("GUARD — moving startDate FORWARD mid-run cannot resurrect a dismissed card", () => {
  // The cohort is on week 5. An admin corrects the start date a fortnight later
  // (a term slipped, a room fell through), and the recomputed anchor goes
  // BACKWARDS to week 3 — a week this member already had, and dismissed.
  const before = currentWeekFor(run(), dayOfRun(30));
  assert.equal(before.anchorWeekNumber, 5);

  const after = currentWeekFor(
    run({ startDate: addDaysToKey(START, 14) }),
    dayOfRun(30),
  );
  assert.equal(after.anchorWeekNumber, 3);

  // The mark is 5, the anchor is 3 → nothing is re-created. On `===` this fell
  // through and re-`.create()`d week 3's card for everyone who had binned it.
  assert.equal(alreadyDelivered(5, after.anchorWeekNumber), true);
  // …and weeks 4 and 5 are not re-created either.
  assert.equal(alreadyDelivered(5, 4), true);
  assert.equal(alreadyDelivered(5, 5), true);
});

test("GUARD — a break inserted BEFORE the cohort's position cannot resurrect a card", () => {
  // The other shape of the same edit. Every slot after the insertion point
  // shifts seven days, so the same calendar week resolves one plan entry
  // earlier and the anchor drops by one.
  const now = dayOfRun(30);
  const before = currentWeekFor(run(), now);
  const after = currentWeekFor(
    run({ weekPlan: [week(1), brk("Reading week"), ...plainPlan(7).slice(1)] }),
    now,
  );
  assert.equal(before.anchorWeekNumber, 5);
  assert.equal(after.anchorWeekNumber, 4);
  assert.equal(alreadyDelivered(before.anchorWeekNumber, after.anchorWeekNumber), true);
});

test("GUARD — the ordinary weekly roll still mirrors, week after week", () => {
  // The other half of the property: a mark that never lets anything through is
  // not a high-water mark, it is an off switch. Walk a clean eight-week run and
  // assert every taught week is delivered exactly once.
  let mark = 0;
  const delivered = [];
  for (let day = 0; day < 56; day += 1) {
    const anchor = currentWeekFor(run(), dayOfRun(day)).anchorWeekNumber;
    if (anchor < 1) continue;
    if (alreadyDelivered(mark, anchor)) continue;
    delivered.push(anchor);
    mark = anchor;
  }
  assert.deepEqual(delivered, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("PROVEN GAP — moving startDate BACKWARD skips weeks that are never mirrored", () => {
  // The cost of a monotonic mark plus "there is deliberately no backlog pass":
  // pull the start date a fortnight EARLIER and the cohort jumps from week 3 to
  // week 5. Weeks 4 and 5's cards… week 5 arrives, week 4 never does.
  const now = dayOfRun(16);
  assert.equal(currentWeekFor(run(), now).anchorWeekNumber, 3);
  const jumped = currentWeekFor(run({ startDate: addDaysToKey(START, -14) }), now).anchorWeekNumber;
  assert.equal(jumped, 5);

  // Only the anchor materialises, so week 4 is skipped for every member.
  const mark = 3;
  assert.equal(alreadyDelivered(mark, jumped), false); // week 5 is created…
  assert.equal(alreadyDelivered(jumped, 4), true); // …and week 4 never will be.
  assert.match(SYNC_TASKS, /There is deliberately no backlog pass/);

  // WHEN YOU FIX THIS: the decision is whether a jumped week is owed its card
  // at all. "Five stale cards for a mid-run joiner" is the harm the no-backlog
  // rule exists to prevent, and a backfill has to distinguish the two cases.
});

test("PROVEN GAP — a jumped week's NUDGE becomes permanently unsendable", () => {
  // The same edit, on the email lane. `resolveNudgeWeek` resolves only the
  // CURRENT slot and `force` re-sends only that same slot, so a week the cohort
  // skipped over has no path to a send and no marker recording the omission.
  assert.match(NUDGE, /const currentWeek = currentWeekFor\(/);
  assert.match(NUDGE, /slotStartKey: currentWeek\.slotStartKey/);
  // No week parameter anywhere: the caller cannot ask for a past week.
  assert.doesNotMatch(NUDGE, /searchParams\.get\("week"\)/);
  assert.doesNotMatch(NUDGE, /body\.weekNumber/);
});

test("GUARD — NO startDate edit, of any size, can escape the duplicate-nudge span", () => {
  // The audit called this one a blocker: "a `startDate` edit of 7 or more days
  // mints a slot key outside the ±6-day span, so `.create()` succeeds and the
  // whole cohort is mailed the same week's nudge twice." IT CANNOT HAPPEN, and
  // this is the proof, because the reasoning is not obvious enough to leave to
  // a comment.
  //
  // Slot keys are always `startDate + k*7`. Shift the start date by `d = 7q + r`
  // and the slot index absorbs the whole `7q`: the key moves by `r` or `r - 7`,
  // never further. So the reachable displacement is exactly [-6, +6] — which is
  // precisely the span `nudgeWeekMarkerIds` consults. A one-day correction and
  // a two-term slip are the same size to this defence.
  //
  // Asserted exhaustively rather than algebraically, over every (edit, day)
  // pair where a second send is even possible: both readings must be `running`,
  // because the route refuses to send at all in the `before` and `after`
  // phases (and both clamp their slot key, which is why they are excluded here
  // rather than being a hole).
  const longPlan = plainPlan(60);
  const slotOf = (startDate, now) => currentWeekFor({ startDate, weekPlan: longPlan }, now);

  let cases = 0;
  let maxDrift = 0;
  for (let d = -60; d <= 60; d += 1) {
    const edited = addDaysToKey(START, d);
    for (let day = 0; day < 60; day += 1) {
      const now = dayOfRun(day);
      const before = slotOf(START, now);
      const after = slotOf(edited, now);
      if (before.phase !== "running" || after.phase !== "running") continue;

      const drift = Math.abs(
        (Date.parse(`${after.slotStartKey}T00:00:00Z`) -
          Date.parse(`${before.slotStartKey}T00:00:00Z`)) /
          86_400_000,
      );
      maxDrift = Math.max(maxDrift, drift);
      assert.ok(
        nudgeWeekMarkerIds("run1", after.slotStartKey).includes(
          nudgeMarkerId("run1", before.slotStartKey),
        ),
        `a ${d}-day edit on day ${day} escaped the span (${before.slotStartKey} → ${after.slotStartKey})`,
      );
      cases += 1;
    }
  }
  assert.ok(cases > 3000, `only ${cases} reachable cases — the loop stopped covering the space`);
  // The ceiling the span is sized against. Six, never seven.
  assert.equal(maxDrift, 6);
});

test("PROVEN GAP — a WEEK PLAN edit still leaves a nudge lane the span cannot reach", () => {
  // The startDate lane is closed (above). The plan lane is not, and it is a
  // different mechanism: a break inserted ahead of the cohort does not move any
  // slot key, so the marker holds — but it renumbers the DISPLAY week, and the
  // route then reports "The cohort is on {label} this week — nothing to send"
  // for a week that was already live and already mailed.
  const now = dayOfRun(16);
  const before = currentWeekFor(run(), now);
  const after = currentWeekFor(
    run({ weekPlan: [week(1), brk("Reading week"), ...plainPlan(7).slice(1)] }),
    now,
  );
  // The marker survives — that half is already pinned by `course-nudge.test.mjs`.
  assert.equal(before.slotStartKey, after.slotStartKey);
  // But the cohort's own week number moved under it, and lands on the break.
  assert.equal(before.weekNumber, 3);
  assert.equal(after.weekNumber, 2);
  const onBreak = currentWeekFor(
    run({ weekPlan: [week(1), week(2), brk("Reading week"), ...plainPlan(6).slice(2)] }),
    now,
  );
  assert.equal(onBreak.weekNumber, null);
  assert.equal(onBreak.breakLabel, "Reading week");
  assert.match(NUDGE, /The cohort is on \$\{label\} this week — nothing to send/);

  // WHEN YOU FIX THIS: the decision is whether a plan edit should be able to
  // retract a week the cohort has already been mailed about. Today it can, and
  // nothing records that it happened.
});

// ===========================================================================
// THE ARCHIVED GROUP — a member left holding a placement nobody serves
// ===========================================================================

const NO_SESSION = { sessionWhen: "", sessionWhere: "" };

/**
 * The nudge route's `groupContextFor`, reproduced. Pinned below.
 *
 * `byGroupId` holds ONLY live, time-bearing groups: `loadGroups` filters
 * `archived` out and skips any group whose slot has no start time.
 */
function groupContextFor(groups, groupId) {
  if (groupId) return groups.byGroupId.get(groupId) ?? NO_SESSION;
  return groups.common ?? NO_SESSION;
}

test("GUARD — a placed member is NEVER mailed another group's session time", () => {
  // The archived-group hole: `loadGroups` drops archived groups, so a member
  // whose group was archived after they were placed is absent from the index —
  // and the shared-session fallback would hand them a time and a room they must
  // not turn up to. The fallback is for the UNPLACED only.
  assert.match(
    NUDGE,
    /function groupContextFor\(groups: GroupIndex, groupId: string \| null\): SessionContext \{\s*if \(groupId\) return groups\.byGroupId\.get\(groupId\) \?\? NO_SESSION;\s*return groups\.common \?\? NO_SESSION;\s*\}/,
    "groupContextFor falls back across groups again",
  );
  assert.match(NUDGE, /\.filter\(\(g\) => !g\.archived\)/);

  const live = { sessionWhen: "Tuesday 20 October, 18:00–19:30", sessionWhere: "Hallward B12" };
  const groups = { byGroupId: new Map([["grp-live", live]]), common: live };

  // A member in the live group gets their own session.
  assert.deepEqual(groupContextFor(groups, "grp-live"), live);
  // A member whose group was archived gets NOTHING — not the other group's.
  assert.deepEqual(groupContextFor(groups, "grp-archived"), NO_SESSION);
  // An unplaced recipient (accepted-not-allocated, or a sender rehearsing)
  // still gets the shared session. That fallback is the documented one.
  assert.deepEqual(groupContextFor(groups, null), live);
});

test("GUARD — that member's email drops the session sentence rather than lying", () => {
  // End to end through the REAL renderer and the REAL seed template: the two
  // empty tokens must delete the whole sentence, not ship "Your group meets ."
  // and not leak the other group's room name from anywhere else in the email.
  const seed = courseTemplateDefaults["course-week-nudge"];
  const context = groupContextFor(
    { byGroupId: new Map([["grp-live", { sessionWhen: "Tuesday 20 October, 18:00–19:30", sessionWhere: "Hallward B12" }]]), common: { sessionWhen: "Tuesday 20 October, 18:00–19:30", sessionWhere: "Hallward B12" } },
    "grp-archived",
  );
  const rendered = renderCourseNudge(
    seed,
    buildCourseNudgeTokens({
      courseTitle: "AI Safety Fundamentals",
      runLabel: "Autumn 2026",
      weekNumber: 3,
      weekTitle: "Goal misgeneralisation",
      weekSummary: "Why a system that learned the right thing can pursue the wrong one.",
      weekPrep: "Two things to read this week.",
      weekUrl: "https://naisi.uk/learn/asf-autumn-2026/weeks/3",
      recipientName: "Alex Taylor",
      ...context,
    }),
  );
  const body = rendered.blocks
    .map((b) => (b.type === "heading" ? b.text : b.type === "richText" ? b.html : ""))
    .join("\n");

  assert.doesNotMatch(body, /Your group meets/);
  assert.doesNotMatch(body, /Hallward/);
  assert.doesNotMatch(body, /18:00/);
  // The rest of the nudge is untouched — they still get their week.
  assert.match(body, /Goal misgeneralisation/);
});

test("GUARD — archiving a group withdraws it from every live surface at once", () => {
  // Four consumers filter `archived`, and each is one member's session card,
  // register or queue disappearing. They must stay in step: a surface that
  // stopped filtering would serve a meet link for a group nobody staffs.
  assert.match(OVERVIEW, /\.filter\(\(g\) => !g\.archived\)/);
  assert.match(NUDGE, /\.filter\(\(g\) => !g\.archived\)/);
  assert.match(ALLOCATION, /archived/);
  // Attendance treats archiving as UNSTAFFING: the facilitator loses the
  // register with the group.
  assert.match(
    ATTENDANCE,
    /group && !group\.archived && group\.facilitatorUids\.includes\(actor\.uid\)/,
  );
});

test("PROVEN GAP — archiving leaves the enrolments, the count and the publish gate behind", () => {
  // `setGroupArchived` writes two fields. It does not unplace anyone, does not
  // zero `memberCount`, and nothing warns that the group still holds members.
  assert.match(
    COURSE_MUTATIONS,
    /export async function setGroupArchived\([\s\S]*?await updateDoc\(doc\(db, "courseGroups", groupId\), \{\s*archived,\s*updatedAt: serverTimestamp\(\),\s*\}\);/,
  );
  assert.doesNotMatch(
    COURSE_MUTATIONS,
    /setGroupArchived[\s\S]{0,400}memberCount/,
    "setGroupArchived now touches memberCount — update this test",
  );

  // And publish deliberately does NOT filter archived, so those members count
  // as placed and the allocation publishes with nobody told. That divergence is
  // documented on purpose; it is pinned here so it cannot be "tidied" on one
  // side only.
  assert.match(ALLOCATION_PUBLISH, /Groups are NOT filtered on\s*\/\/ archived here/);
  assert.match(ALLOCATION_PUBLISH, /e\.groupId === null \|\| e\.status !== "active"/);

  // WHEN YOU FIX THIS: the decision is what archiving MEANS while members hold
  // placements — refuse it, unplace them, or warn and proceed. The board reads
  // them as UNALLOCATED either way, which is the state publish says is fine.
});

// ===========================================================================
// A TAUGHT WEEK REMOVED FROM THE PLAN
// ===========================================================================

/** `taughtWeeksOf` from the attendance route, reproduced. Pinned below. */
function taughtWeeksOf(weekPlan) {
  const out = [];
  const seen = new Set();
  for (const entry of weekPlan) {
    if (entry.kind !== "week") continue;
    const n = entry.weekNumber;
    if (!Number.isInteger(n) || n < 1 || n > 60 || seen.has(n)) continue;
    seen.add(n);
    out.push({ weekNumber: n, weekId: entry.weekId });
  }
  return out;
}

/** `columnsFor` from the attendance route, reproduced. Pinned below. */
function columnsFor(taught, anchor, requestedWeek) {
  const first = taught[0]?.weekNumber ?? 0;
  const upTo = Math.max(anchor, requestedWeek ?? 0, first);
  return taught.filter((w) => w.weekNumber <= upTo);
}

test("GUARD — taughtWeeksOf refuses to mint a column from a corrupt plan entry", () => {
  assert.match(ATTENDANCE, /function taughtWeeksOf\(run: CourseRunDoc\): TaughtWeek\[\]/);
  assert.match(ATTENDANCE, /seen\.has\(n\)/);
  const messy = [
    week(1),
    brk("Reading week"),
    { kind: "week", weekNumber: 1, weekId: "w09" }, // duplicate number
    { kind: "week", weekNumber: 0, weekId: "w00" }, // out of range
    { kind: "week", weekNumber: 2.5, weekId: "w02" }, // not an integer
    { kind: "week", weekNumber: 999, weekId: "w99" }, // past the ceiling
    week(2),
  ];
  assert.deepEqual(
    taughtWeeksOf(messy).map((w) => w.weekNumber),
    [1, 2],
  );
  // `sanitizeWeekPlan` is deliberately weaker — it checks TYPES only, which is
  // exactly why the route re-checks the range and uniqueness itself.
  assert.equal(sanitizeWeekPlan(messy).length, 7);
});

test("GUARD — columnsFor never hides a week the facilitator has already marked", () => {
  const taught = taughtWeeksOf(plainPlan(8));
  // `?week=N` can only ADD columns.
  assert.match(ATTENDANCE, /const upTo = Math\.max\(anchor, requestedWeek \?\? 0, first\);/);
  assert.equal(columnsFor(taught, 3, null).length, 3);
  assert.equal(columnsFor(taught, 3, 6).length, 6);
  assert.equal(columnsFor(taught, 3, 1).length, 3); // cannot shrink
  // A run with no usable start date has no anchor, and the floor keeps the
  // grid from rendering as an unexplained empty table.
  assert.equal(columnsFor(taught, 0, null).length, 1);
});

test("PROVEN GAP — removing a taught week strands its register beyond reach", () => {
  // Eight taught weeks, all marked. The admin presses ✕ on slot 5, and
  // `renumber()` reassigns the numbers of everything after it while keeping
  // their week ids.
  const before = taughtWeeksOf(renumber(plainPlan(8)));
  assert.deepEqual(before.map((w) => w.weekNumber), [1, 2, 3, 4, 5, 6, 7, 8]);

  const after = renumber([...plainPlan(8).slice(0, 4), ...plainPlan(8).slice(5)]);
  const taught = taughtWeeksOf(after);
  assert.deepEqual(taught.map((w) => w.weekNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    after.map((e) => e.weekId),
    ["w01", "w02", "w03", "w04", "w06", "w07", "w08"],
  );

  // 1. WEEK 8's REGISTER IS ORPHANED. The marks live at a deterministic id
  //    derived from the NUMBER, and no taught week carries that number now.
  assert.equal(attendanceDocId("run1", "grp1", 8), "run1__grp1__w08");
  assert.equal(taught.some((w) => w.weekNumber === 8), false);
  // The grid cannot show it: the widening happens INSIDE the taught filter, so
  // `?week=8` — the only escape hatch the route has — cannot bring it back.
  assert.equal(columnsFor(taught, 7, 8).some((w) => w.weekNumber === 8), false);
  // And POST refuses to correct it, so the marks are invisible AND un-editable.
  assert.match(ATTENDANCE, /isn't a taught week of this run/);
  assert.match(
    ATTENDANCE,
    /const week = taughtWeeksOf\(run\)\.find\(\(w\) => w\.weekNumber === weekNumber\);/,
  );

  // 2. WORSE, THE SURVIVING REGISTERS RE-ATTACH TO DIFFERENT WEEKS. What the
  //    plan now calls week 5 is the curriculum doc w06 — but its register is
  //    `…__w05`, which holds the marks taken for the week that was DELETED.
  const nowFifth = taught[4];
  assert.equal(nowFifth.weekNumber, 5);
  assert.equal(nowFifth.weekId, "w06");
  assert.equal(attendanceDocId("run1", "grp1", nowFifth.weekNumber), "run1__grp1__w05");
  assert.notEqual(attendanceDocId("run1", "grp1", nowFifth.weekNumber), `run1__grp1__${nowFifth.weekId}`);

  // WHEN YOU FIX THIS: the decision is whether removing a week should be
  // refused while a register or an exercise response exists for it, or whether
  // the grid should render orphaned weeks in a read-only column. Deleting the
  // data is the one answer that is definitely wrong.
});

test("PROVEN GAP — a removed week's exercise answers leave the review queue unreviewed", () => {
  // Responses are stored with a `weekNumber` DERIVED from the week id at submit
  // time and queried back by number, so they stay addressable — but both the
  // member's page and the facilitator queue ask for a week the plan no longer
  // lists, so nobody ever sees them again.
  assert.match(SUBMIT, /weekNumber/);
  assert.match(MY_EXERCISES, /\.where\("weekNumber", "==", week\)/);
  assert.match(GROUP_EXERCISES, /\.where\("weekNumber", "==", week\)/);
  // The queue additionally filters to ACTIVE members, so a removed member's
  // already-submitted answers disappear the same way.
  assert.match(GROUP_EXERCISES, /status.*active|"active"/);
});

// ===========================================================================
// UN-PUBLISHING A WEEK MEMBERS HAVE ALREADY DONE
// ===========================================================================

test("PROVEN GAP — un-publishing a week takes a member's completed work off their total", () => {
  // ProgressBody filters on `published` BEFORE building rows, so an unpublished
  // week leaves the numerator AND the denominator: a member who had finished it
  // watches the headline "N of M" go DOWN, with their courseProgress rows still
  // stored and unreachable.
  assert.match(PROGRESS_BODY, /\.filter\(\(week\) => week\.published\)/);
  assert.match(PROGRESS_BODY, /if \(!row\.counted\) continue;/);
  // The mirrored My Work card is never removed — the projection is one-way —
  // so a task stays on their board linking to a page they cannot open.
  assert.doesNotMatch(SYNC_TASKS, /taskRef\.delete\(/);
  // The week page itself withholds the doc from learners.
  assert.match(WEEK_VIEW, /useWeek\(runId, weekDocId\(weekNumber\), viewerRole !== "learner"\)/);

  // WHEN YOU FIX THIS: the decision is whether `published` is a ONE-WAY door
  // once a cohort has read the week. Everything downstream assumes it is.
});

// ===========================================================================
// RUN STATUS — forward-only in the route, unconstrained in the rules
// ===========================================================================

/** The status route's table, reproduced. Pinned below. */
const ALLOWED_TRANSITIONS = {
  draft: ["applications-open", "cancelled"],
  "applications-open": ["applications-closed", "cancelled"],
  "applications-closed": ["running", "cancelled"],
  running: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

test("GUARD — the status route's transition table is forward-only and terminal-safe", () => {
  for (const [from, to] of Object.entries(ALLOWED_TRANSITIONS)) {
    assert.match(
      STATUS_ROUTE,
      new RegExp(`"?${from}"?:\\s*\\[${to.map((s) => `"${s}"`).join(", ")}\\]`),
      `the table no longer says ${from} → ${to.join("/")}`,
    );
  }
  // Nothing leaves a terminal state, and nothing walks backwards.
  assert.deepEqual(ALLOWED_TRANSITIONS.completed, []);
  assert.deepEqual(ALLOWED_TRANSITIONS.cancelled, []);
  const order = ["draft", "applications-open", "applications-closed", "running", "completed"];
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of targets) {
      if (to === "cancelled") continue;
      assert.ok(
        order.indexOf(to) > order.indexOf(from),
        `${from} → ${to} is not forward`,
      );
    }
  }
  assert.match(STATUS_ROUTE, /Deliberately forward-only/);
});

test("GUARD — a run walked backwards is refused new work by both write lanes", () => {
  // The allowlists are the containment: whatever the status becomes, `draft`,
  // `completed` and `cancelled` hand nobody new homework and mail nobody.
  for (const [source, name] of [[SYNC_TASKS, "MIRRORING_STATUSES"], [NUDGE, "NUDGING_STATUSES"]]) {
    const block = new RegExp(`${name}[\\s\\S]{0,300}?\\]\\)`).exec(source);
    assert.ok(block, `${name} is no longer a set literal`);
    for (const forbidden of ["draft", "completed", "cancelled"]) {
      assert.equal(
        block[0].includes(`"${forbidden}"`),
        false,
        `${name} now admits ${forbidden}`,
      );
    }
    assert.ok(block[0].includes('"running"'), `${name} no longer admits running`);
  }
});

test("PROVEN GAP — a completed run is not read-only, because nothing ever completes an enrolment", () => {
  // Two of the four declared enrolment statuses are unreachable. `courseProgress`
  // writes gate on the ENROLMENT (`isEnrolledActive`), never on the run — so a
  // completed or cancelled run keeps full member write access forever, which
  // directly contradicts what the overview route says about itself.
  assert.deepEqual([...ENROLMENT_STATUSES].sort(), [
    "active",
    "completed",
    "removed",
    "withdrawn",
  ]);
  assert.match(OVERVIEW, /a completed run is read-only by\s*(?:\*\s*)?construction/);

  // The only enrolment-status writers in the whole feature.
  assert.match(ALLOCATE, /status: "active"/);
  assert.match(REMOVE_ROUTE, /status: "removed"/);
  assert.match(FACILITATORS, /"active"|"removed"/);
  // Nothing writes the other two onto an enrolment.
  for (const source of [ALLOCATE, REMOVE_ROUTE, FACILITATORS, STATUS_ROUTE]) {
    assert.doesNotMatch(source, /status:\s*"withdrawn"/);
  }
  assert.doesNotMatch(STATUS_ROUTE, /courseEnrolments/);

  // WHEN YOU FIX THIS: the decision is whether completing a run should settle
  // its enrolments (a fan-out write over the cohort) or whether the progress
  // rules should read the run's status (an extra get() per rule evaluation,
  // which the courses rules suite explicitly warns costs the access budget).
});

// ===========================================================================
// joinedWeekNumber — stamped once at placement, never re-derived
// ===========================================================================

test("GUARD — allocation clamps joinedWeekNumber to a real week", () => {
  // Pre-term allocation is the NORMAL case: the anchor is 0 before the run
  // starts, and an unclamped 0 would make every week "before you joined" and
  // exclude the entire course from the member's own progress total.
  assert.match(
    ALLOCATE,
    /Math\.max\(1, currentWeekFor\(run\)\.anchorWeekNumber\)/,
  );
  const beforeStart = currentWeekFor(run(), new Date(`${addDaysToKey(START, -3)}T12:00:00Z`));
  assert.equal(beforeStart.anchorWeekNumber, 0);
  assert.equal(Math.max(1, beforeStart.anchorWeekNumber), 1);
  // A run with no usable start date also anchors to week 1 rather than throwing.
  assert.equal(isValidDateKey(""), false);
  assert.match(ALLOCATE, /isValidDateKey\(run\.startDate\)\s*\?[\s\S]{0,80}:\s*1;/);
});

test("PROVEN GAP — a startDate correction leaves joinedWeekNumber describing no real week", () => {
  // Allocation ran while `startDate` sat in the past (setup, or a test run).
  // The anchor was week 5, so every member carries `joinedWeekNumber: 5`. The
  // date is then corrected forward to the real term start.
  const stamped = Math.max(1, currentWeekFor(run(), dayOfRun(30)).anchorWeekNumber);
  assert.equal(stamped, 5);

  const corrected = run({ startDate: addDaysToKey(START, 35) });
  const nowAnchor = currentWeekFor(corrected, dayOfRun(30)).anchorWeekNumber;
  assert.equal(nowAnchor, 0); // the run has not started yet

  // Nothing re-derives the stamp, so the member is recorded as having joined at
  // week 5 of a cohort that is on week 0.
  const enrolment = normalizeCourseEnrolment(courseEnrolmentId("run1", "u1"), {
    runId: "run1",
    uid: "u1",
    joinedWeekNumber: stamped,
    status: "active",
    role: "learner",
  });
  assert.equal(enrolment.joinedWeekNumber, 5);
  assert.ok(enrolment.joinedWeekNumber > nowAnchor);

  // Two surfaces then lie, in opposite directions.
  assert.match(PROGRESS_BODY, /counted: week\.weekNumber >= joinedWeek/);
  assert.match(PROGRESS_BODY, /You joined this cohort at week \{joinedWeek\}/);
  assert.match(ATTENDANCE, /hadn't joined the group in week \$\{weekNumber\}/);
  // The clearing path is exempt, which is the one mercy already built in.
  assert.match(ATTENDANCE, /status !== null && weekNumber < member\.joinedWeekNumber/);

  // WHEN YOU FIX THIS: the decision is whether `joinedWeekNumber` is a FACT
  // ("they turned up in week 5") or a DERIVED value. If it is a fact, the fix
  // is an admin control to correct it; if it is derived, allocation should stop
  // stamping it and every reader should recompute.
});

// ===========================================================================
// THE ACCEPTED-BUT-UNALLOCATED MEMBER — the reported bug
// ===========================================================================

test("GUARD — deciding an application enrols nobody", () => {
  // Not a bug: an offer is not a seat, and allocation owns the
  // no-double-placement invariant. It is the PREMISE of the gap below, so it is
  // pinned rather than assumed.
  assert.match(DECIDE, /DECIDING DOES NOT ENROL ANYONE/);
  assert.doesNotMatch(DECIDE, /collection\("courseEnrolments"\)/);
});

test("GUARD — an offer survives admissions closing the run, which is what broke it", () => {
  // THE REPORTED BUG, and the schedule half of why it happened. Deciding
  // enrols nobody (above), so between "you're in" and allocation being
  // published an accepted applicant held no row in any collection the hub read.
  // The ONE surface that ever said they got in was the apply page's status
  // card — reachable only while `getApplyContext` finds a run still in
  // `applications-open`, which is exactly the state admissions moves OFF next.
  // Every schedule-driven surface then agreed they were on nothing.
  //
  // `/api/courses/me` now carries a fourth signal, so the hub no longer depends
  // on the run's status to know an offer exists. (The precedence rules of
  // `membershipFor` are `tests/course-offer.test.mjs`'s subject and are not
  // duplicated here — what this test holds is that the STATUS-INDEPENDENCE
  // survives, because that is the property the schedule can break.)
  assert.match(ME, /\.collection\("courseApplications"\)/);
  assert.match(ME, /export function membershipFor/);
  assert.match(ME, /membership: membershipFor\(\{/);
  // The application query is scoped to the caller and filters on NOTHING else —
  // no run status, no date window, no application status. That is the whole
  // property: a run moving to `applications-closed` (or `running`) must not be
  // able to take the offer row away again, which is exactly how the reported
  // bug was triggered. The status vocabulary is narrowed afterwards, in
  // `membershipFor`, where the run's calendar cannot reach it.
  assert.match(
    ME,
    /\.collection\("courseApplications"\)\s*\.where\("uid", "==", actor\.uid\)\s*\.limit\(\d+\)\s*\.get\(\)/,
    "/api/courses/me's offer query grew a filter — a run's status can hide an offer again",
  );

  // The rest of the trace is unchanged and still correct, so it is pinned: an
  // offer is NOT a door. A row with no live enrolment holds no role, and the
  // run layout bounces it — which is why the fix had to be a distinct kind of
  // row rather than a faked enrolment.
  assert.match(RUN_LAYOUT, /if \(!hasRunRole\) redirect\("\/learn"\);/);
  assert.match(MY_COURSES_SUMMARY, /if \(loading \|\| error \|\| live\.length === 0\) return null;/);
  // Still true, and still the reason the hub had to be the place this was
  // fixed: the PUBLIC course page tells an accepted member applications are
  // shut, because it branches on the open run and nothing else.
  assert.match(COURSE_CTA, /Applications aren&apos;t open right now\./);
  assert.match(COURSE_CTA, /if \(!openRun\)/);
  assert.match(APPLY_FORM, /You're in\. We'll email you your group/);
  assert.match(FETCH_COURSES, /if \(run\.status !== "applications-open"\) continue;/);
  assert.match(STATUS_ROUTE, /"applications-open": \["applications-closed", "cancelled"\]/);
});

test("PROVEN GAP — their only record is an email whose {startDate} is frozen", () => {
  // The acceptance email formats the run's start date at DECISION time, and
  // there is no re-send path: a re-decide into the same status reports no
  // change, so nothing can re-issue it. The later placement email recomputes
  // its own date live, so the same member can hold two emails naming different
  // days.
  assert.match(DECIDE, /startDate/);
  assert.match(DECIDE, /changed/);
  assert.match(ALLOCATION_PUBLISH, /function firstSessionWhen/);
  // The publish-side value is derived on every send…
  assert.match(ALLOCATION_PUBLISH, /firstSessionWhen\(run, group\)/);
  // …and nothing re-mails the acceptance.
  assert.doesNotMatch(STATUS_ROUTE, /sendCourseApplication/);
});

// ===========================================================================
// THE FROZEN AVAILABILITY STRING, AND THE MULTI-RUN APPLY TARGET
// ===========================================================================

test("PROVEN GAP — an applicant's availability is a frozen label, not a group reference", () => {
  // Deliberate, and documented: nothing has to track a group that gets renamed.
  // The cost is that changing a group's weekday or time after applications are
  // in leaves every stored availability describing a slot that no longer
  // exists, with the allocation board rendering it verbatim.
  assert.match(APPLY_ROUTE, /function joinAvailability\(chosen: string\[\]\): string/);
  assert.match(APPLY_ROUTE, /const availability = joinAvailability\(resolved\.chosen\);/);
  assert.match(ALLOCATION, /splitAvailability/);
  // No group ids are stored on the application.
  assert.doesNotMatch(APPLY_ROUTE, /availabilityGroupIds/);
});

test("PROVEN GAP — editing applicationsCloseAt can switch which run an apply page names", () => {
  // `preferredOpenRun` picks the soonest-closing run with an unbounded window
  // sorting last, so an edit to a close date silently changes which run the
  // public CTA and the apply page describe — mid-session, for someone with the
  // form already open.
  assert.match(FETCH_COURSES, /function preferredOpenRun\(a: CourseRunDoc, b: CourseRunDoc\)/);
  assert.match(FETCH_COURSES, /Number\.POSITIVE_INFINITY/);
  // The form posts to the runId it was RENDERED with, and nothing compares that
  // to the run the page would choose now.
  assert.match(APPLY_FORM, /runs\/\$\{encodeURIComponent\(runId\)\}\/apply/);
  assert.doesNotMatch(APPLY_ROUTE, /runMismatch|staleRun/);

  // The ordering itself, modelled — an unbounded window must sort LAST or a run
  // with no close date would always win and the CTA would never move.
  const soonest = (a, b) => {
    const av = a.closeAt ?? Number.POSITIVE_INFINITY;
    const bv = b.closeAt ?? Number.POSITIVE_INFINITY;
    if (av !== bv) return av < bv ? a : b;
    return a.label.localeCompare(b.label) <= 0 ? a : b;
  };
  const autumn = { label: "Autumn 2026", closeAt: 200 };
  const spring = { label: "Spring 2027", closeAt: 100 };
  const open = { label: "Rolling", closeAt: null };
  assert.equal(soonest(autumn, spring).label, "Spring 2027");
  assert.equal(soonest(autumn, open).label, "Autumn 2026");
  // Deterministic on a tie, so the CTA does not flip between requests.
  assert.equal(soonest({ label: "B", closeAt: 1 }, { label: "A", closeAt: 1 }).label, "A");
});

// ===========================================================================
// FIELDS THAT DO NOTHING, AND DATES THAT ARE NOT DATES
// ===========================================================================

test("PROVEN GAP — applicationCap is written, normalised, and read by nobody", () => {
  // An admin who lowers the cap to close a cohort down has changed nothing and
  // gets no feedback saying so. Asserted by construction rather than by memory:
  // the field appears only where it is authored, typed or stored.
  assert.match(APPLY_ROUTE, /`applicationCap` is SOFT and is deliberately NOT checked here/);
  const readers = [
    [ALLOCATE, "allocate"],
    [ALLOCATION, "allocation"],
    [APPLY_ROUTE.replace(/^[\s\S]*?export/, "export"), "apply (code, not comments)"],
    [ME, "me"],
    [OVERVIEW, "overview"],
    [DECIDE, "decide"],
  ];
  for (const [source, name] of readers) {
    assert.doesNotMatch(
      source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""),
      /applicationCap/,
      `${name} now reads applicationCap`,
    );
  }

  // WHEN YOU FIX THIS: either enforce it in the apply route (and decide what an
  // applicant sees when the cap is hit — a closed page, or a waitlist), or
  // delete the field. A control that does nothing is worse than no control.
});

test("GUARD — every date-driven consumer guards with isValidDateKey before pacing", () => {
  // `currentWeekFor` THROWS on a malformed date by design, and a half-authored
  // run is a legitimate state — so each consumer degrades to "no dates" instead
  // of 500ing a page mount. Remove any one guard and that surface throws.
  for (const [source, name] of [
    [ME, "me"],
    [OVERVIEW, "overview"],
    [NUDGE, "nudge"],
    [SYNC_TASKS, "sync-tasks"],
    [ATTENDANCE, "attendance"],
    [ALLOCATE, "allocate"],
    [ALLOCATION_PUBLISH, "allocation/publish"],
  ]) {
    assert.match(source, /isValidDateKey\(/, `${name} no longer guards its date`);
  }
  assert.throws(() => currentWeekFor({ startDate: "2026-02-31", weekPlan: [] }), RangeError);
  assert.throws(() => currentWeekFor({ startDate: "", weekPlan: [] }), RangeError);
});

test("PROVEN GAP — an impossible date passes the run normaliser and silently kills the run", () => {
  // `2026-02-31` matches the shape and is not a day. The normaliser keeps it,
  // `isValidDateKey` rejects it, and every consumer degrades: no current week,
  // no rail, no pacing, no nudge, no mirror, no attendance anchor. The run looks
  // alive and does nothing, with no error anywhere to explain it.
  const stored = normalizeCourseRun("run1", {
    courseId: "c1",
    label: "Autumn 2026",
    startDate: "2026-02-31",
    weekPlan: [],
  });
  assert.equal(stored.startDate, "2026-02-31");
  assert.equal(isValidDateKey(stored.startDate), false);
  // The normaliser rejects a wrong SHAPE, which is all it checks.
  assert.equal(normalizeCourseRun("run1", { startDate: "05/10/2026" }).startDate, "");

  // WHEN YOU FIX THIS: `asCivilDate` in `lib/firestore/courses.ts` should call
  // `isValidDateKey` rather than the bare regex — a one-line change that makes
  // an impossible date behave exactly like an unset one. `firestore.rules`
  // cannot do this check at all (no date arithmetic), so the normaliser is the
  // only place it can live.
});

test("GUARD — currentWeekFor clamps its slot key at both ends of the run", () => {
  // The clamp is what stops "next session" maths from having no date to work
  // from when a run is edited to start in the future or has already finished —
  // both states an admin reaches by editing `startDate` alone.
  const before = currentWeekFor(run(), new Date(`${addDaysToKey(START, -30)}T12:00:00Z`));
  assert.equal(before.phase, "before");
  assert.equal(before.slotStartKey, START);
  assert.equal(before.anchorWeekNumber, 0);

  const after = currentWeekFor(run(), new Date(`${addDaysToKey(START, 200)}T12:00:00Z`));
  assert.equal(after.phase, "after");
  assert.equal(after.slotStartKey, addDaysToKey(START, 7 * 7));
  assert.equal(after.anchorWeekNumber, 8);

  // An empty plan — a run created and never given slots — is "after" from day
  // one and anchors to nothing, rather than throwing on an index that is not
  // there.
  const empty = currentWeekFor({ startDate: START, weekPlan: [] }, dayOfRun(3));
  assert.equal(empty.phase, "after");
  assert.equal(empty.anchorWeekNumber, 0);
  assert.equal(empty.slotStartKey, START);
});

// ===========================================================================
// THE COUNTERS
// ===========================================================================

test("PROVEN GAP — applicationCounts can drift from the rows it summarises, with no recount", () => {
  // The counters move only as relative increments inside the apply and decide
  // transactions, the decide route says outright that the fix for drift is a
  // recount pass, and no such pass exists anywhere. Both the queue and the run
  // editor render the counters as headline numbers directly above the rows they
  // are supposed to summarise, so the two can visibly disagree on one screen.
  assert.match(DECIDE, /the fix is a recount pass/);
  const anyRecount = [APPLY_ROUTE, DECIDE, STATUS_ROUTE, ALLOCATION_PUBLISH].some((s) =>
    /function recount|recountApplications/.test(s),
  );
  assert.equal(anyRecount, false, "a recount pass exists now — invert this test");
  assert.match(DECIDE, /FieldValue\.increment/);

  // WHEN YOU FIX THIS: a recount is a read of every application row for the run
  // (already bounded at 500 by the queue's own query), so the cheap version is
  // to fold it into the applications GET the admin is already loading.
});
