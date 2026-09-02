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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  // `groupResolve.ts` carries SERVER helpers alongside its pure ones, so it may
  // name the Admin SDK. Types are erased by the transpile; a VALUE import would
  // otherwise drag firebase-admin into a unit test. Stubbed so the pure half
  // stays importable and the server half stays unreachable — no test in this
  // file may touch Firestore.
  [
    "firebase-admin/firestore",
    "const refuse = () => {\n" +
      "  throw new Error('firebase-admin is stubbed in tests');\n};\n" +
      "export const FieldValue = { serverTimestamp: refuse, increment: refuse, delete: refuse };\n" +
      "export const Timestamp = { fromDate: refuse, now: refuse };",
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
const { normalizeCourseRun, sanitizeMaterials, sanitizeWeekPlan, weekDocId } =
  await loadTs("lib/firestore/courses.ts");
const {
  GROUP_FIELD_LIMITS,
  normalizeCourseGroup,
  sessionForWeek,
  sessionModeForWeek,
  sessionModesOf,
} = await loadTs("lib/firestore/courseGroups.ts");
// THE resolver (V2-3). Only its PURE half is exercised here — the server
// helpers need a Firestore and this suite has none, so copy-on-write
// resolution is modelled below and pinned to the consumers by source.
const { divergenceNote, groupsDiverge, memberCurrentWeek, resolveCalendar } =
  await loadTs("lib/courses/groupResolve.ts");
const { attendanceDocId } = await loadTs("lib/firestore/courseAttendance.ts");
const { ENROLMENT_STATUSES, courseEnrolmentId, normalizeCourseEnrolment } =
  await loadTs("lib/firestore/courseEnrolments.ts");
const { courseTaskId } = await loadTs("lib/firestore/courseTasks.ts");
const {
  buildCourseNudgeTokens,
  courseNudgeSessionWhere,
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

const MATERIAL_NOTES = api("runs", "[runId]", "material-notes", "route.ts");
const PACE = api("groups", "[groupId]", "pace", "route.ts");
const NOTICE = api("groups", "[groupId]", "notice", "route.ts");
const GROUP_WEEK_PATCH = api("groups", "[groupId]", "weeks", "[weekId]", "route.ts");
const COURSES_LIB = src("lib", "firestore", "courses.ts");
const GROUP_RESOLVE = src("lib", "courses", "groupResolve.ts");

const WEEK_PLAN_BUILDER = src("features", "courses", "WeekPlanBuilder.tsx");
const WEEK_VIEW = src("features", "courses", "WeekView.tsx");
const RUN_HOME = src("features", "courses", "RunHome.tsx");
const USE_WEEK = src("features", "courses", "useWeek.ts");
const USE_GROUP_WEEKS = src("features", "courses", "useGroupWeeks.ts");
const USE_ALLOCATION = src("features", "courses", "useAllocation.ts");
const PACING_BANNER = src("features", "courses", "PacingBanner.tsx");
const ALLOCATION_BOARD = src("features", "courses", "AllocationBoard.tsx");
const SESSION_CARD = src("features", "courses", "SessionCard.tsx");
const ROOM_NOTICE = src("features", "courses", "RoomNoticeComposer.tsx");
const NUDGE_EMAIL = src("lib", "email", "courseNudgeEmail.ts");
const FACILITATOR_EMAILS = src("lib", "email", "courseFacilitatorEmails.ts");
const EMAIL_SENDS = src("lib", "firestore", "emailSends.ts");
const PROGRESS_BODY = src("app", "(app)", "learn", "[runId]", "progress", "ProgressBody.tsx");
const LEARN_GROUP = (...parts) =>
  src("app", "(app)", "learn", "[runId]", "group", "[groupId]", ...parts);
const GROUP_PAGE = LEARN_GROUP("page.tsx");
const GROUP_REVIEW_PAGE = LEARN_GROUP("review", "page.tsx");
const GROUP_EDIT_INDEX = LEARN_GROUP("edit", "page.tsx");
const GROUP_EDIT_WEEK = LEARN_GROUP("edit", "[weekId]", "page.tsx");
const RUN_LAYOUT = src("app", "(app)", "learn", "[runId]", "layout.tsx");
const MY_COURSES_SUMMARY = src("features", "courses", "MyCoursesSummary.tsx");
const COURSE_CTA = src("features", "courses", "CourseCTA.tsx");
const APPLY_FORM = src("features", "courses", "ApplyForm.tsx");
const FETCH_COURSES = src("features", "courses", "fetchCourses.ts");
const COURSE_MUTATIONS = src("features", "courses", "courseMutations.ts");
const NORMALISE_WEEKS = api("runs", "[runId]", "normalise-weeks", "route.ts");
const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

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

/**
 * CODE ONLY — comments and string BODIES removed, in one left-to-right pass.
 *
 * Several guards below ask "does this file really DO x", and this is what
 * makes the question answerable in a codebase that names its own helpers in
 * prose on nearly every page. The two-`replace` version it replaces — one
 * regex for line comments, a second for block comments, applied in that order
 * — had a hole that runs the wrong way:
 *
 *     const docs = "https://example.test"; const w = currentWeekFor(run);
 *
 * The `//` inside the URL opened a "comment" that ate the rest of the line —
 * INCLUDING the call. A guard whose evasion is an ordinary string literal is a
 * guard that can be walked past by accident, which is worse than one that can
 * be walked past on purpose.
 *
 * Scanning left to right in one pass is what fixes it: whichever construct
 * STARTS first consumes its own body, so a `//` inside a string is never a
 * comment and a quote inside a comment never opens a string. Template literals
 * are tracked properly because `${…}` is real code inside a string, and a call
 * written there must still count.
 *
 * KNOWN LIMIT, written down rather than re-discovered: regex literals are not
 * lexed (telling `/` division from `/` regex needs the parser this is not), so
 * a line whose regex ends `…\//` still loses its tail. That is exactly the old
 * behaviour, it has never hidden a call in this tree, and the guard below
 * would have to be a compiler to close it. If it ever bites, the symptom is a
 * call site the guard fails to flag — check here first.
 */
function codeOf(source) {
  const out = [];
  const n = source.length;
  // Brace depths at which a `${` was opened, so `}` knows when it is closing
  // an interpolation (back into the string) rather than a block.
  const interpolations = [];
  let depth = 0;
  let inTemplate = false;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (inTemplate) {
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        inTemplate = false;
        out.push('""');
        i += 1;
      } else if (c === "$" && d === "{") {
        inTemplate = false;
        interpolations.push(depth);
        depth += 1;
        out.push(" ");
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && source[i] !== c) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      // A token, not nothing: `a"x"b` must not become the identifier `ab`.
      out.push('""');
      continue;
    }
    if (c === "`") {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (interpolations[interpolations.length - 1] === depth) {
        interpolations.pop();
        inTemplate = true;
        out.push(" ");
        i += 1;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/**
 * Does this source really reach `currentWeekFor` — by call OR by alias?
 *
 * THE SECOND EVASION. The name match alone is defeated by one import:
 *
 *     import { currentWeekFor as anchorOf } from "@/lib/courses/weekPlan";
 *
 * after which `anchorOf(run)` paces a member off the run's calendar with the
 * guard none the wiser. Chasing the local binding would need a module graph,
 * so the alias ITSELF is the offence: there is no legitimate reason to rename
 * this function on import, and refusing the rename keeps the cheap name match
 * sufficient. Checked on stripped code, so the sentence you are reading — and
 * every other one that says "currentWeekFor as" in prose — is not an offence.
 */
function callsCurrentWeekFor(source) {
  const code = codeOf(source);
  return (
    /\bcurrentWeekFor\s*\(/.test(code) || /\bcurrentWeekFor\s+as\s+[A-Za-z_$]/.test(code)
  );
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

/**
 * `courseMutations.weekAddressDrift()`, reproduced. Not imported because
 * `courseMutations.ts` is a "use client" module that pulls in the Firebase web
 * SDK; pinned to the real one by the source assertion in its own test below.
 */
function weekAddressDrift(plan) {
  const out = [];
  let taught = 0;
  for (const entry of plan) {
    if (entry.kind !== "week") continue;
    taught += 1;
    const canonicalWeekId = weekDocId(taught);
    if (entry.weekId !== canonicalWeekId) {
      out.push({ weekNumber: taught, planWeekId: entry.weekId, canonicalWeekId });
    }
  }
  return out;
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

test("GUARD — one press of ▲ still permutes the addressing, and that is now BOUNDED", () => {
  // The exact sequence from the audit: add a week (it takes the lowest free id,
  // w05) then move it to position 2.
  const added = renumber([...plainPlan(4), { kind: "week", weekNumber: 0, weekId: "w05" }]);
  const moved = renumber([added[0], added[4], added[1], added[2], added[3]]);

  // The admin's arrangement: slot 2 is the week they just wrote (w05).
  assert.equal(moved[1].weekNumber, 2);
  assert.equal(moved[1].weekId, "w05");

  // The divergence itself is UNCHANGED and deliberate. /learn/{run}/weeks/2
  // resolves weekDocId(2) = "w02", which is now the plan's week 3; four of the
  // five entries point at a document other than the one the admin put in that
  // position. Recomputing `weekId` here would repoint authored curriculum and
  // everyone's saved progress, which is the harm the builder's comment exists
  // to prevent, and rewriting the ten member-facing readers to honour the
  // plan's id costs `attendanceDocId` and `courseTaskId` their derivability
  // from a number. Neither was the answer.
  assert.notEqual(weekDocId(moved[1].weekNumber), moved[1].weekId);
  assert.equal(planIsCanonicallyAddressed(moved), false);
  const drifted = moved.filter((e) => e.weekId !== weekDocId(e.weekNumber));
  assert.equal(drifted.length, 4);

  // CLOSED 2026-09-02 by bounding the state instead of picking a doctrine.
  // Three things now hold, and the rest of this section pins each of them:
  //
  //  1. the drift is REPORTED rather than silent (`weekAddressDrift`);
  //  2. it is RECONCILABLE, but only in draft, where no member work exists to
  //     repoint (POST /api/courses/runs/[runId]/normalise-weeks);
  //  3. it is UNREACHABLE afterwards, because firestore.rules pins `weekPlan`
  //     for non-admins once a run leaves draft.
  //
  // So a reorder can still permute the addressing, and only inside the window
  // where permuting it costs nothing.
});

test("GUARD — weekAddressDrift names exactly the slots whose two spellings disagree", () => {
  const added = renumber([...plainPlan(4), { kind: "week", weekNumber: 0, weekId: "w05" }]);
  const moved = renumber([added[0], added[4], added[1], added[2], added[3]]);

  const drift = weekAddressDrift(moved);
  assert.deepEqual(
    drift.map((d) => [d.weekNumber, d.planWeekId, d.canonicalWeekId]),
    [
      [2, "w05", "w02"],
      [3, "w02", "w03"],
      [4, "w03", "w04"],
      [5, "w04", "w05"],
    ],
  );

  // Silent on a plan that has only ever grown at the end, which is the common
  // case and must not nag.
  assert.deepEqual(weekAddressDrift(renumber(plainPlan(8))), []);
  assert.deepEqual(
    weekAddressDrift(renumber([...plainPlan(3), brk("Reading week")])),
    [],
  );
  // A break shifts DATES, not week numbers, so inserting one mid-plan leaves
  // the addressing alone.
  assert.deepEqual(
    weekAddressDrift(renumber([plainPlan(4)[0], brk("Reading week"), ...plainPlan(4).slice(1)])),
    [],
  );

  // Pinned to the real helper, so the model above cannot drift from it.
  assert.match(COURSE_MUTATIONS, /export function weekAddressDrift\(plan: WeekPlanEntry\[\]\)/);
  assert.match(COURSE_MUTATIONS, /const canonicalWeekId = weekDocId\(taught\);/);
  assert.match(
    COURSE_MUTATIONS,
    /out\.push\(\{ weekNumber: taught, planWeekId: entry\.weekId, canonicalWeekId \}\)/,
  );

  // And the builder surfaces it: the panel is rendered from this helper, and
  // only while the run is still reshapeable.
  assert.match(WEEK_PLAN_BUILDER, /weekAddressDrift\(weekPlan\)/);
  assert.match(WEEK_PLAN_BUILDER, /!locked && drift\.length > 0/);
});

test("GUARD — the normalise route refuses outside the one window where it is free", () => {
  // The whole safety argument is the draft check plus the emptiness checks: in
  // draft there is nothing keyed on the old ids, so moving them repoints
  // nothing. Every one of these is load-bearing.
  assert.match(NORMALISE_WEEKS, /\(run\.status \?\? "draft"\) !== "draft"/);
  assert.match(NORMALISE_WEEKS, /actor\.role === "admin" \|\| actor\.permissions\.approveCourse/);
  assert.match(NORMALISE_WEEKS, /collection\("courseProgress"\)\.where\("runId", "==", runId\)/);
  assert.match(
    NORMALISE_WEEKS,
    /collection\("courseExerciseResponses"\)\s*\.where\("runId", "==", runId\)/,
  );
  // Group-level content is keyed by week doc id too, and is not this route's
  // to rewrite.
  assert.match(NORMALISE_WEEKS, /sessionOverrides/);
  assert.match(NORMALISE_WEEKS, /collection\("weeks"\)\.limit\(1\)/);
  // A run mid-destroy is frozen here for the same reason it is frozen in the
  // status route.
  assert.match(NORMALISE_WEEKS, /run\.destroying === true/);

  // Copy THEN delete, in one batch: the moves are a permutation, so a source
  // id is very often also a destination id and deleting as it goes would drop
  // a week it had just written.
  assert.match(NORMALISE_WEEKS, /const destinations = new Set\(moves\.map\(\(m\) => m\.to\)\)/);
  assert.match(NORMALISE_WEEKS, /if \(destinations\.has\(move\.from\)\) continue;/);
  assert.match(NORMALISE_WEEKS, /await batch\.commit\(\)/);
});

test("GUARD — the rules pin weekPlan the moment a run stops being a draft", () => {
  // The affordance in the builder is not the enforcement. This is.
  assert.match(RULES, /function weekPlanLockRespected\(\)/);
  assert.match(
    RULES,
    /resource\.data\.get\('status', 'draft'\) == 'draft'\s*\|\|\s*request\.resource\.data\.get\('weekPlan', \[\]\)\s*==\s*resource\.data\.get\('weekPlan', \[\]\)/,
  );
  // On the NON-admin branch only, matching every other pin in that block: an
  // admin adding a slot to a live run is a decision they own, not one to
  // forbid. The builder mirrors the split.
  assert.match(RULES, /&& runContentOk\(\)\s*&& weekPlanLockRespected\(\)/);
  assert.match(WEEK_PLAN_BUILDER, /const canReshape = !locked;/);
  assert.match(WEEK_PLAN_BUILDER, /const canGrow = !locked \|\| isAdmin;/);
  // Reorder and remove are gone once locked; add-at-end survives for admins.
  assert.match(WEEK_PLAN_BUILDER, /function move\(index: number, dir: -1 \| 1\) \{\s*if \(!canReshape\) return;/);
  assert.match(WEEK_PLAN_BUILDER, /function removeAt\(index: number\) \{\s*if \(!canReshape\) return;/);
  assert.match(WEEK_PLAN_BUILDER, /if \(full \|\| !canGrow\) return;/);
});

test("GUARD — every member-facing surface addresses a week by weekDocId(number)", () => {
  // Ten readers, one doctrine. This is the assertion that keeps an eleventh
  // from being written against the plan's `weekId` by accident.
  const readers = [
    [WEEK_VIEW, /useWeek\(runId, weekDocId\(weekNumber\)/],
    // The session-mode lookup joined the doctrine when the mode became a MAP
    // keyed by week doc id (see the per-week card test): two surfaces now index
    // it, and both must spell the key the way every writer of that map does.
    [WEEK_VIEW, /sessionModes\[weekDocId\(weekNumber\)\]/],
    [RUN_HOME, /sessionModes\[weekDocId\(cardWeekNumber\)\]/],
    [NUDGE, /const weekId = weekDocId\(weekNumber\);/],
    // V2-3 moved the mirror's read behind the group resolver, so the pattern
    // now pins BOTH doctrines at once: addressed by number, resolved
    // group-first. A mirror built from a different document than the member's
    // week page opens is exactly the bug this row exists to catch.
    [SYNC_TASKS, /resolveWeekDoc\(db, runId, groupId, weekDocId\(weekNumber\)\)/],
    [OVERVIEW, /return n >= 1 \? weekDocId\(n\) : "";/],
    [GROUP_PAGE, /const weekId = weekNumber >= 1 \? weekDocId\(weekNumber\) : "";/],
    [GROUP_EXERCISES, /const weekId = weekDocId\(week\);/],
    // ── V2-3 SHOULD-FIX 6: THE FACILITATOR EDITOR ─────────────────────────
    // The newest surface in the feature arrived on the OTHER doctrine — it
    // keyed its rows, its links and its page-param match on the plan entry's
    // own `weekId`. After a break insert that means a facilitator forks "w03"
    // while their own members read "w04": the fork is invisible to the group
    // it was made for, and nothing anywhere says so. These three rows are why
    // that class is now pinned shut rather than re-discovered.
    [USE_GROUP_WEEKS, /const weekId = weekDocId\(entry\.weekNumber\);/],
    [
      GROUP_EDIT_WEEK,
      /entry\.kind === "week" && weekDocId\(entry\.weekNumber\) === weekId/,
    ],
    [
      GROUP_EDIT_INDEX,
      /slot && slot\.kind === "week" \? weekDocId\(slot\.weekNumber\) : ""/,
    ],
  ];
  for (const [source, pattern] of readers) {
    assert.match(source, pattern);
  }
  // …and the editor no longer reads the plan entry's own spelling ANYWHERE,
  // which is the half a positive match cannot prove: a file can satisfy the
  // pattern above and still resolve `entry.weekId` two lines later.
  for (const [source, name] of [
    [USE_GROUP_WEEKS, "useGroupWeeks"],
    [GROUP_EDIT_WEEK, "the group week edit page"],
    [GROUP_EDIT_INDEX, "the group edit index"],
  ]) {
    assert.doesNotMatch(
      source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""),
      /\b(entry|slot)\.weekId\b/,
      `${name} resolves a plan entry's own weekId again`,
    );
  }
  // The register id too, so a week's attendance and a week's page cannot end up
  // addressed by two different keys.
  assert.equal(attendanceDocId("run1", "grp1", 3), "run1__grp1__w03");
  assert.equal(courseTaskId("run1", 3, "u1").split("__")[0], `course-${weekDocId(3)}`);
});

test("GUARD — the editor's fork target is the doc its own members read", () => {
  // The doctrine guard above is a source assertion; this is the DATA fact it
  // protects, so a future reader can see why the two spellings are not
  // interchangeable rather than taking the regexes on faith.
  //
  // The audit's exact sequence: add a fifth week (it takes the lowest free id,
  // w05) and move it to position 2. The plan entry in slot 2 now carries
  // `weekId: "w05"` while every member surface resolves `weekDocId(2)` = "w02".
  const added = renumber([...plainPlan(4), { kind: "week", weekNumber: 0, weekId: "w05" }]);
  const moved = renumber([added[0], added[4], added[1], added[2], added[3]]);
  const slot = moved[1];

  assert.equal(slot.weekNumber, 2);
  assert.equal(slot.weekId, "w05");
  assert.notEqual(weekDocId(slot.weekNumber), slot.weekId);

  // What a member reads for that slot, through the resolver's own rule.
  const canonical = { w02: { id: "w02", title: "Canonical two" } };
  const forks = { grpA: {} };
  const memberReads = weekDocId(slot.weekNumber);
  assert.equal(memberReads, "w02");

  // The editor forks THAT id, so the fork lands where the member looks…
  forks.grpA[memberReads] = { id: memberReads, title: "Ana's two" };
  assert.equal(resolveWeek(canonical, forks, "grpA", memberReads).title, "Ana's two");
  // …whereas a fork written at the plan's own spelling is read by nobody: the
  // member still gets the canonical, and the facilitator's work is invisible.
  const strandedForks = { grpA: { [slot.weekId]: { id: slot.weekId, title: "Ana's two" } } };
  assert.equal(
    resolveWeek(canonical, strandedForks, "grpA", memberReads).title,
    "Canonical two",
  );
});

test("GUARD — no reader resolves sessionOverrides by the plan entry's own weekId", () => {
  // Closed 2026-08-22 (this test was the PROVEN GAP that demanded it): the
  // attendance register header and the allocation email were the last two
  // readers passing a PLAN ENTRY's `weekId` into `sessionForWeek`, whose keys
  // every member-facing surface writes and reads as `weekDocId(n)`. On a
  // reordered plan the two doctrines disagree, so staff saw a different
  // session than members. Both now derive the key from the week NUMBER.
  //
  // If this goes red, a reader has reverted to (or newly adopted) the plan-id
  // doctrine — align it with `weekDocId(weekNumber)` instead.
  assert.doesNotMatch(ATTENDANCE, /sessionForWeek\(group, week\.weekId\)/);
  assert.match(ATTENDANCE, /sessionForWeek\(group, weekDocId\(week\.weekNumber\)\)/);
  assert.doesNotMatch(ALLOCATION_PUBLISH, /\? firstWeek\.weekId/);
  assert.match(ALLOCATION_PUBLISH, /weekDocId\(firstWeek\.weekNumber\)/);

  // Attendance stays internally consistent: the register beside the header is
  // addressed by NUMBER too.
  assert.match(ATTENDANCE, /attendanceDocId\(runId, groupId, weekNumber\)/);
});

test("GUARD — the two week keys really do resolve different overrides on a reordered plan", () => {
  // The data-model property that made the closed gap dangerous, kept as the
  // reason the doctrine guard above exists: an override written for the week
  // the member sees as week 2 is keyed "w02", while the plan entry that slot
  // now holds can carry the id "w05". Any reader that keys by the plan id
  // resolves a DIFFERENT override than every member surface.
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

  // The number-derived key (what every reader now uses) — the override applies.
  assert.equal(sessionForWeek(group, weekDocId(planEntry.weekNumber)).location, "Monica Partridge A11");
  // The plan entry's own id — a different answer, which is why no reader may use it.
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

test("GUARD — the three-way drift has exactly ONE reconciler, and it is draft-only", () => {
  // The three spellings are unchanged: the plan says one thing, the week doc's
  // own `weekNumber` field says another, and `weekDocId(n)` addresses a third.
  assert.match(COURSE_MUTATIONS, /weekNumber/);
  assert.match(
    COURSE_MUTATIONS,
    /so the editor can reconcile a doc whose number has drifted/,
  );
  // The ordinary save still writes ONLY `weekPlan` — it does not quietly
  // re-stamp week docs behind the admin's back, which on a live run would be
  // the very repointing the preserved id exists to prevent.
  assert.match(WEEK_PLAN_BUILDER, /await updateRun\(runId, \{ weekPlan: plan \}\)/);
  assert.doesNotMatch(WEEK_PLAN_BUILDER, /ensureWeekDoc|saveWeek/);
  // The overview's week index still labels and sorts by the STORED field while
  // the link it renders resolves `weekDocId(number)`, which is exactly why a
  // drifted number is worth reconciling rather than tolerating forever.
  assert.match(OVERVIEW, /\.sort\(\(a, b\) => a\.weekNumber - b\.weekNumber/);
  assert.match(PROGRESS_BODY, /byWeek\.get\(week\.weekNumber\)/);

  // CLOSED 2026-09-02: there is now a reconciler, it lives in one place, and it
  // re-stamps the stored field as part of the same batch that moves the docs —
  // including the slots that are already at the right id but carry a stale
  // number ("restamps"), which is the case no move would have touched.
  assert.match(NORMALISE_WEEKS, /restamps\.push\(\{ weekId: to, from: doc\.weekNumber, to: taught \}\)/);
  assert.match(NORMALISE_WEEKS, /batch\.update\(weeksCol\.doc\(restamp\.weekId\), \{\s*weekNumber: restamp\.to,/);
  // …and it writes the plan and the docs together, so the two cannot half-land.
  assert.match(NORMALISE_WEEKS, /batch\.update\(runRef, \{\s*weekPlan: next,/);
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
  // V2-3 hands it a RESOLVED plan (the group's own when it has one), so it
  // takes the plan rather than the run — the defence is a property of week-plan
  // data, not of where the data came from.
  assert.match(
    ATTENDANCE,
    /function taughtWeeksOf\(weekPlan: WeekPlanEntry\[\]\): TaughtWeek\[\]/,
  );
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
  // (V2-3: the refusal now names the GROUP's schedule, because that is what it
  // is checked against — the group's resolved plan, not the run's raw one.)
  assert.match(ATTENDANCE, /isn't a taught week of this group's schedule/);
  assert.match(
    ATTENDANCE,
    /const week = taughtWeeksOf\(calendar\.weekPlan\)\.find\(\(w\) => w\.weekNumber === weekNumber\);/,
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
  // The week page itself withholds the doc from learners — and V2-3 extends
  // that gate to a group's FORKED copy, so a facilitator's half-written fork
  // is withheld from their own members by the same predicate.
  assert.match(WEEK_VIEW, /const canSeeDrafts = viewerRole !== "learner";/);
  assert.match(WEEK_VIEW, /useWeek\(runId, weekDocId\(weekNumber\), canSeeDrafts, weekSrc\)/);
  assert.match(USE_WEEK, /if \(!week\.published && !canSeeUnpublished\)/);

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

/**
 * `joinedWeekFor` from the allocate route, reproduced — pinned to the real one
 * by the source assertions below. `now` is a parameter here only because the
 * route takes the real clock.
 */
const joinedWeekFor = (runDoc, group, now) => {
  const calendar = resolveCalendar(runDoc, group);
  return isValidDateKey(calendar.startDate)
    ? Math.max(1, memberCurrentWeek(runDoc, group, now).anchorWeekNumber)
    : 1;
};

/** The attendance route's mid-run-joiner refusal, reproduced (pinned below). */
const attendanceRefuses = (weekNumber, joinedWeekNumber, status = "present") =>
  status !== null && weekNumber < joinedWeekNumber;

test("GUARD — allocation clamps joinedWeekNumber to a real week", () => {
  // Pre-term allocation is the NORMAL case: the anchor is 0 before the run
  // starts, and an unclamped 0 would make every week "before you joined" and
  // exclude the entire course from the member's own progress total.
  assert.match(
    ALLOCATE,
    /Math\.max\(1, memberCurrentWeek\(run, group\)\.anchorWeekNumber\)/,
  );
  const beforeStart = new Date(`${addDaysToKey(START, -3)}T12:00:00Z`);
  assert.equal(memberCurrentWeek(run(), null, beforeStart).anchorWeekNumber, 0);
  assert.equal(joinedWeekFor(run(), null, beforeStart), 1);
  // A run with no usable start date also anchors to week 1 rather than throwing
  // — and the guard is on the RESOLVED date, since a group's own start date is
  // just as capable of being half-authored as the run's.
  assert.equal(isValidDateKey(""), false);
  assert.equal(joinedWeekFor(run({ startDate: "" }), null, beforeStart), 1);
  assert.match(ALLOCATE, /isValidDateKey\(calendar\.startDate\)\s*\?[\s\S]{0,90}:\s*1;/);
  assert.match(ALLOCATE, /const calendar = resolveCalendar\(run, group\);/);
});

test("GUARD — a mid-run joiner is stamped with THEIR GROUP's week, not the run's", () => {
  // THE BUG. `joinedWeekNumber` was one value hoisted OUT of the per-placement
  // loop and computed from the RUN's calendar, for everybody in the request.
  // Groups pace themselves now, so that stamped a number from a clock the
  // member does not live on.
  const now = dayOfRun(30);
  // The run is on week 5. The group started a fortnight later, so it is on
  // week 3 — a perfectly ordinary "we had to push the start back" group.
  const behind = {
    paceStartDate: addDaysToKey(START, 14),
    paceWeekPlan: null,
  };
  assert.equal(memberCurrentWeek(run(), null, now).anchorWeekNumber, 5);
  assert.equal(memberCurrentWeek(run(), behind, now).anchorWeekNumber, 3);

  const stampedFromRun = Math.max(1, memberCurrentWeek(run(), null, now).anchorWeekNumber);
  const stampedFromGroup = joinedWeekFor(run(), behind, now);
  assert.equal(stampedFromRun, 5); // what the hoisted value gave them
  assert.equal(stampedFromGroup, 3); // what their group's clock actually says

  // THE CONSEQUENCE, which is why this is not cosmetic. `joinedWeekNumber` is
  // a FLOOR the attendance route enforces, so the old stamp hard-refused the
  // register for the two weeks the group is about to sit through — weeks that
  // exist, are taught, and are the member's own.
  for (const weekNumber of [3, 4]) {
    assert.equal(attendanceRefuses(weekNumber, stampedFromRun), true);
    assert.equal(attendanceRefuses(weekNumber, stampedFromGroup), false);
  }
  // Week 3 is a taught week of the group's effective plan, so there is nothing
  // else standing between the facilitator and the mark.
  const taught = resolveCalendar(run(), behind)
    .weekPlan.filter((e) => e.kind === "week")
    .map((e) => e.weekNumber);
  assert.ok(taught.includes(3));
  // Clearing was always exempt, and stays exempt.
  assert.equal(attendanceRefuses(3, stampedFromRun, null), false);

  // A group paced AHEAD is the mirror image, and it must NOT be clamped down
  // to the run: that member really did join at their group's week 7.
  const ahead = { paceStartDate: addDaysToKey(START, -14), paceWeekPlan: null };
  assert.equal(joinedWeekFor(run(), ahead, now), 7);

  // A group tracking the run is byte-identical to the old behaviour, which is
  // what makes this safe to land on every existing placement.
  assert.equal(joinedWeekFor(run(), null, now), stampedFromRun);
  assert.equal(
    joinedWeekFor(run(), { paceStartDate: null, paceWeekPlan: null }, now),
    stampedFromRun,
  );

  // ── THE SOURCE ────────────────────────────────────────────────────────────
  // Resolved PER PLACEMENT, from the TARGET group, inside the transaction —
  // the group doc is already read there for the capacity check, so this costs
  // no extra read.
  assert.match(ALLOCATE, /joinedWeekNumber: joinedWeekFor\(run, targetGroup\),/);
  assert.match(ALLOCATE, /function joinedWeekFor\(run: CourseRunDoc, group: CourseGroupDoc \| null\)/);
  // …and NOT hoisted out of the loop any more. A bare `const joinedWeekNumber =`
  // at request scope is exactly the shape of the bug.
  assert.doesNotMatch(codeOf(ALLOCATE), /const joinedWeekNumber =/);
  // The route no longer reaches for the run's own clock at all — which is what
  // lets it come OFF the `currentWeekFor` allowlist below.
  assert.equal(callsCurrentWeekFor(ALLOCATE), false);
  assert.match(ALLOCATE, /from "@\/lib\/courses\/groupResolve"/);
  // The two readers this floor feeds, pinned so the consequence above stays
  // real rather than remembered.
  assert.match(ATTENDANCE, /status !== null && weekNumber < member\.joinedWeekNumber/);
  assert.match(PROGRESS_BODY, /counted: week\.weekNumber >= joinedWeek/);
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

test("GUARD — an impossible date normalises to unset rather than killing the run", () => {
  // Closed 2026-09-02 (this test was the PROVEN GAP that demanded it):
  // `asCivilDate` now calls `isValidDateKey` instead of a bare shape regex.
  // `2026-02-31` matches the shape and is not a day; storing it used to leave
  // every consumer degraded at once (no current week, no rail, no pacing, no
  // nudge, no mirror, no attendance anchor) with the run looking alive and
  // doing nothing. It now reads back as "", which is a state every one of
  // those readers already handles and every editing surface already prompts on.
  const stored = normalizeCourseRun("run1", {
    courseId: "c1",
    label: "Autumn 2026",
    startDate: "2026-02-31",
    weekPlan: [],
  });
  assert.equal(stored.startDate, "");

  // Every flavour of impossible, not just the February one: an out-of-range
  // month, a zero month, and a value that is all-digits nonsense.
  for (const impossible of ["2026-02-31", "2026-13-01", "2026-00-10", "9999-99-99"]) {
    assert.equal(
      normalizeCourseRun("run1", { startDate: impossible }).startDate,
      "",
      `${impossible} survived the normaliser`,
    );
    assert.equal(isValidDateKey(impossible), false);
  }

  // A wrong SHAPE still normalises away, as it always did.
  assert.equal(normalizeCourseRun("run1", { startDate: "05/10/2026" }).startDate, "");

  // …and a REAL date is untouched, including the leap day a month-length table
  // would get wrong. This is the half of the contract a stricter check could
  // plausibly break.
  for (const good of ["2026-09-28", "2024-02-29", "2026-12-31", "2027-01-01"]) {
    assert.equal(normalizeCourseRun("run1", { startDate: good }).startDate, good);
  }

  // The normaliser is the ONLY layer that can hold this: `firestore.rules` has
  // no date arithmetic, so its regex stays the strongest thing that layer can
  // say. Its sibling in `scripts/rules-tests/tests/courses-schedule.test.mjs`
  // pins that division of labour from the other side.
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
// PER-GROUP AUTONOMY — copy-on-write content, per-group pacing (V2-3)
//
// The schedule can now be edited in TWO places, and the whole feature rests on
// one rule: a member's week is their group's forked copy if it exists, else
// the run canonical, and their calendar is their group's override if set, else
// the run's — resolved in ONE helper that every consumer imports.
//
// Everything below is a GUARD. The failure modes they exist to catch are all
// silent ones: content that leaks across a fork, a fork that escapes its own
// group, a group's pacing that moves a RUN-level idempotency key, and an
// unallocated member whose resolution quietly stopped being the run's.
// ===========================================================================

/**
 * Copy-on-write resolution, MODELLED. The real one is `resolveWeekDoc` in
 * `groupResolve.ts`, which needs a Firestore this suite does not have — so the
 * rule is modelled here and the CONSUMERS are pinned to the real helper by the
 * source assertions in the last test of this section. Both halves, or the
 * model is a description of a program nobody runs.
 */
function resolveWeek(canonical, forks, groupId, weekId) {
  const fork = groupId ? forks[groupId]?.[weekId] : undefined;
  return fork ?? canonical[weekId] ?? null;
}

/**
 * A group doc with the V2-3 autonomy fields laid on top of a real normalise.
 * `forkedWeekIds` is NOT stored on the doc — it is the id list of the group's
 * weeks subcollection, which `groupsDiverge` takes as an argument — so it is
 * defaulted here exactly as an unforked group's caller would pass it.
 */
const groupWith = (id, autonomy = {}) => ({
  ...normalizeCourseGroup(id, { runId: "run1", name: id }),
  paceStartDate: null,
  paceWeekPlan: null,
  forkedWeekIds: [],
  ...autonomy,
});

/** What an UNPLACED member resolves as: the run canonical, nothing overridden. */
const RUN_CANONICAL = { paceStartDate: null, paceWeekPlan: null, forkedWeekIds: [] };

test("GUARD — a run-canonical edit does NOT leak into a forked group week", () => {
  // The single most important property of copy-on-write: the fork is taken at
  // the moment the facilitator first edits, and NOTHING merges back or forward
  // afterwards. An admin refining the canonical week 3 must not silently
  // rewrite the version a group is already reading.
  const canonical = { w03: { id: "w03", title: "Goal misgeneralisation" } };
  const forks = { grpA: { w03: { id: "w03", title: "Goal misgeneralisation (Ana's cut)" } } };

  assert.equal(resolveWeek(canonical, forks, "grpA", "w03").title, "Goal misgeneralisation (Ana's cut)");

  // The admin edits the canonical afterwards.
  canonical.w03 = { id: "w03", title: "Goal misgeneralisation, rewritten" };

  // The forked group is untouched…
  assert.equal(
    resolveWeek(canonical, forks, "grpA", "w03").title,
    "Goal misgeneralisation (Ana's cut)",
  );
  // …and everyone who has NOT forked moves with the run, which is the other
  // half of the promise: refinements propagate until someone personalises.
  assert.equal(resolveWeek(canonical, forks, "grpB", "w03").title, "Goal misgeneralisation, rewritten");
  assert.equal(resolveWeek(canonical, forks, null, "w03").title, "Goal misgeneralisation, rewritten");

  // An UNFORKED week of a group that has forked a DIFFERENT week still tracks
  // canonical — the fork is per (group, week), never per group.
  canonical.w04 = { id: "w04", title: "Week 4" };
  assert.equal(resolveWeek(canonical, forks, "grpA", "w04").title, "Week 4");
});

test("GUARD — one group's fork is invisible to every other group", () => {
  const canonical = { w05: { id: "w05", title: "Canonical five" } };
  const forks = {
    grpA: { w05: { id: "w05", title: "A's five" } },
    grpB: { w05: { id: "w05", title: "B's five" } },
  };
  assert.equal(resolveWeek(canonical, forks, "grpA", "w05").title, "A's five");
  assert.equal(resolveWeek(canonical, forks, "grpB", "w05").title, "B's five");
  // A group with no fork of its own, and an unplaced member, both read the run.
  assert.equal(resolveWeek(canonical, forks, "grpC", "w05").title, "Canonical five");
  assert.equal(resolveWeek(canonical, forks, null, "w05").title, "Canonical five");
  // A week nobody has authored is missing for everyone — a fork can only ever
  // REPLACE a canonical week, never conjure one for a reader outside the group.
  assert.equal(resolveWeek(canonical, forks, "grpA", "w09"), null);
});

test("GUARD — an unallocated member's resolution is byte-identical to the run's", () => {
  // The regression this suite would otherwise never notice: every surface got
  // a new resolution step, and the population WITHOUT a group is the one that
  // must come out the far side unchanged.
  const r = run();
  const cal = resolveCalendar(r, null);
  assert.equal(cal.startDate, r.startDate);
  assert.deepEqual(cal.weekPlan, r.weekPlan);
  assert.equal(cal.source, "run");

  const at = dayOfRun(20);
  assert.deepEqual(memberCurrentWeek(r, null, at), currentWeekFor(r, at));

  // A group that has NOT overridden its pacing is the same case: null means
  // "track the run", so the overwhelmingly common path stays the old path.
  const tracking = resolveCalendar(r, groupWith("grpA"));
  assert.equal(tracking.startDate, r.startDate);
  assert.deepEqual(tracking.weekPlan, r.weekPlan);
  assert.equal(tracking.source, "run");
  assert.deepEqual(memberCurrentWeek(r, groupWith("grpA"), at), currentWeekFor(r, at));
});

test("GUARD — a group's pacing override moves that group, and only that group", () => {
  const r = run();
  // Two weeks behind the run.
  const behind = groupWith("grpA", { paceStartDate: addDaysToKey(START, 14) });
  const cal = resolveCalendar(r, behind);
  assert.equal(cal.source, "group");
  assert.equal(cal.startDate, addDaysToKey(START, 14));

  const at = dayOfRun(21); // run week 4, group week 2
  assert.equal(currentWeekFor(r, at).weekNumber, 4);
  assert.equal(memberCurrentWeek(r, behind, at).weekNumber, 2);
  // Their neighbours are untouched.
  assert.equal(memberCurrentWeek(r, groupWith("grpB"), at).weekNumber, 4);
  assert.equal(memberCurrentWeek(r, null, at).weekNumber, 4);
});

test("GUARD — a group's pace override cannot move the RUN's nudge marker", () => {
  // The nudge's idempotency key is per (run, CALENDAR SLOT) and stays that way
  // (see the route header): one send, one claim, one record, whatever the
  // groups are doing. If a group's pacing could reach the marker id, twelve
  // groups would mean twelve chances to double-mail the same cohort.
  const r = run();
  const at = dayOfRun(21);
  const runSlot = currentWeekFor(r, at).slotStartKey;
  // Ten days, not fourteen: a whole number of WEEKS behind would put the
  // group's slot boundary on the same civil date as the run's, and this test
  // would pass without ever asking its question.
  const behind = groupWith("grpA", { paceStartDate: addDaysToKey(START, 10) });
  const groupSlot = memberCurrentWeek(r, behind, at).slotStartKey;

  // The two really have parted — this test is about something, not a tautology.
  assert.notEqual(groupSlot, runSlot);
  // …and the marker is keyed on the RUN's slot, so it does not move.
  assert.equal(nudgeMarkerId("run1", runSlot), nudgeMarkerId("run1", runSlot));
  assert.notEqual(nudgeMarkerId("run1", groupSlot), nudgeMarkerId("run1", runSlot));

  // The route pins that: the week it claims comes from `resolveNudgeWeek(db,
  // run, …)` — the RUN — and the marker id is built from that week's slot.
  assert.match(NUDGE, /const resolved = await resolveNudgeWeek\(db, run, now\);/);
  assert.match(NUDGE, /\.doc\(nudgeMarkerId\(runId, resolved\.slotStartKey\)\)/);
  assert.match(NUDGE, /findWeekMarker\(db, runId, resolved\.slotStartKey\)/);
  // And the decision is written down where the next reader will find it.
  assert.match(NUDGE, /THE RUN'S CADENCE DECIDES \*WHEN\*/);
});

test("GUARD — the nudge resolves CONTENT per recipient but never a foreign session", () => {
  // The deliberate asymmetry (nudge route header): an unresolved group falls
  // back to the RUN's week (shared curriculum, safe) but NEVER to another
  // group's session time (a room they must not turn up to).
  assert.match(NUDGE, /function groupWeekFor\(/);
  assert.match(NUDGE, /if \(!groupId\) return runWeek;\s*return weeks\.get\(groupId\) \?\? runWeek;/);
  // Resolved once per DISTINCT GROUP, before the dispatch loop — a per-recipient
  // read would put 200 round trips inside a 60s request.
  assert.match(NUDGE, /resolveGroupWeeks\(\s*db,\s*runId,\s*groups,\s*recipients\.map\(\(r\) => r\.groupId\),\s*\)/);
  // …and each recipient's tokens come from THEIR week, not the run's.
  assert.match(NUDGE, /const week = groupWeekFor\(groupWeeks, recipient\.groupId, runWeek\);/);
  assert.match(NUDGE, /weekUrl: courseWeekUrl\(appUrl, runId, week\.weekNumber\)/);
  // An unpublished fork is never mailed: a facilitator's half-written week must
  // not go out on the run's cadence.
  assert.match(NUDGE, /if \(!week \|\| !week\.published\) return;/);
});

test("GUARD — every member-facing consumer resolves through the ONE helper", () => {
  // THE design rule, as a source assertion. A seventh consumer that paces a
  // member off `run.startDate` directly is the way this feature breaks, and it
  // breaks silently — the run's calendar is right for most members most of the
  // time.
  for (const [source, name] of [
    [ME, "me"],
    [OVERVIEW, "overview"],
    [SYNC_TASKS, "sync-tasks"],
    [NUDGE, "nudge"],
    [ATTENDANCE, "attendance"],
    [GROUP_EXERCISES, "group exercises"],
    [ALLOCATION_BOARD, "allocation board"],
  ]) {
    assert.match(
      source,
      /from "@\/lib\/courses\/groupResolve"/,
      `${name} no longer imports the resolver`,
    );
  }

  // No MEMBER-facing surface paces off the run's own calendar any more. The
  // nudge is the one deliberate exception (its TRIGGER is run-level), and it
  // is excluded by name rather than by omission.
  for (const [source, name] of [
    [ME, "me"],
    [OVERVIEW, "overview"],
    [SYNC_TASKS, "sync-tasks"],
    [ATTENDANCE, "attendance"],
  ]) {
    assert.doesNotMatch(
      source,
      /currentWeekFor\(/,
      `${name} paces a member off the run's calendar again`,
    );
  }
  assert.match(NUDGE, /currentWeekFor\(/);

  // The week-content readers go through `resolveWeekDoc`, never a raw
  // `courseRuns/{id}/weeks` get.
  assert.match(GROUP_EXERCISES, /resolveWeekDoc\(db, group\.runId, groupId, weekId\)/);
  assert.doesNotMatch(GROUP_EXERCISES, /\.doc\(group\.runId\)\s*\.collection\("weeks"\)/);

  // The client half: the overview SENDS the fork list, and `useWeek` resolves
  // against it rather than probing for a document that usually isn't there.
  assert.match(OVERVIEW, /forkedWeekIds: string\[\]/);
  assert.match(OVERVIEW, /calendarSource: calendar\.source/);
  assert.match(WEEK_VIEW, /forkedWeekIds: overview\.data\.forkedWeekIds/);
  assert.match(USE_WEEK, /doc\(getClientDb\(\), "courseGroups", groupId, "weeks", weekId\)/);
  assert.match(USE_WEEK, /doc\(getClientDb\(\), "courseRuns", runId, "weeks", weekId\)/);

  // The disclosures. Each is one sentence standing between a member and a
  // silent difference they cannot otherwise account for.
  assert.match(WEEK_VIEW, /Customised by your facilitator/);
  assert.match(PACING_BANNER, /pacedByGroup \? "your group" : "your cohort"/);
  // The board's note is BUILT in the resolver too, not just gated by it — the
  // sentence has to know which side diverges, and that is a fact about
  // divergence rather than about the board (see the direction test below).
  assert.match(ALLOCATION_BOARD, /divergenceNote\(/);
  assert.doesNotMatch(
    codeOf(ALLOCATION_BOARD),
    /diverge\.pace \|\| diverge\.content|parts\.push\(/,
    "the board is wording divergence itself again",
  );
});

test("GUARD — groupsDiverge answers about pace and content SEPARATELY", () => {
  // The board's disclosure predicate. Three properties matter.
  //
  // (1) It must stay SILENT on the overwhelmingly common move — two groups
  //     that have overridden nothing, including moves out of the unallocated
  //     pool, which reads as the run canonical.
  // (2) It must fire on EVERY kind of divergence, in both directions: leaving
  //     a diverged group is as much of a change as joining one.
  // (3) The two facts must stay SEPARATE. Pacing changes which week a member
  //     is on today; content changes what that week contains. A single boolean
  //     would make the board's sentence wrong about one of them half the time.
  const plain = groupWith("grpA");
  const paced = groupWith("grpB", { paceStartDate: addDaysToKey(START, 7) });
  const replanned = groupWith("grpD", {
    paceWeekPlan: [...plainPlan(3), brk("Reading week"), ...plainPlan(5).slice(3)],
  });
  const forked = groupWith("grpC", { forkedWeekIds: ["w03"] });

  for (const [a, b] of [
    [plain, plain],
    [RUN_CANONICAL, plain],
    [plain, RUN_CANONICAL],
    // `null` is the unallocated pool's own spelling on the board.
    [null, plain],
    [null, null],
  ]) {
    assert.deepEqual(groupsDiverge(a, b), { pace: false, content: false });
  }

  // Pace alone, content alone — never conflated.
  for (const other of [paced, replanned]) {
    assert.deepEqual(groupsDiverge(plain, other), { pace: true, content: false });
    assert.deepEqual(groupsDiverge(other, plain), { pace: true, content: false });
    assert.deepEqual(groupsDiverge(null, other), { pace: true, content: false });
  }
  assert.deepEqual(groupsDiverge(plain, forked), { pace: false, content: true });
  assert.deepEqual(groupsDiverge(forked, plain), { pace: false, content: true });

  // Both at once, and the DELIBERATELY CONSERVATIVE fork rule: two groups that
  // forked the SAME week ids still diverge, because two forks of w03 are two
  // independent copies and the predicate does not read week bodies to find
  // out. A spurious sentence costs an allocator two seconds; a missing one is
  // silent.
  assert.deepEqual(groupsDiverge(paced, forked), { pace: true, content: true });
  assert.deepEqual(
    groupsDiverge(forked, groupWith("grpE", { forkedWeekIds: ["w03"] })),
    { pace: false, content: true },
  );
});

// ===========================================================================
// PER-GROUP AUTONOMY, PART 2 — THE SURFACES THAT HAD NOT CAUGHT UP
//
// Everything above pins the RESOLVER and the consumers that were converted
// with it. This section is the review's findings: surfaces that kept resolving
// the run while the member was reading their group, settings that were written
// and read by nobody, and a monotonic mark that a facilitator's own act could
// wedge shut. All GUARDs — every one of these failed silently, and every one
// of them costs a member something they cannot get back (an answer, an
// evening, a week of cards).
// ===========================================================================

test("GUARD — exercise submission validates against the week the MEMBER was shown", () => {
  // THE BUG: `WeekView` renders the member's group's fork; the submit route
  // read `courseRuns/{runId}/weeks/{weekId}`. Three silent divergences, each
  // costing the member their answer — modelled below through the SAME
  // resolution rule both ends now use.
  const canonical = {
    w03: {
      id: "w03",
      exercises: [
        { id: "x1", responseType: "text" },
        { id: "x9", responseType: "text" },
      ],
    },
  };
  const forks = {
    grpA: {
      w03: {
        id: "w03",
        exercises: [
          // responseType FLIPPED by the facilitator…
          { id: "x1", responseType: "link" },
          // …one ADDED…
          { id: "x2", responseType: "text" },
          // …and x9 REMOVED.
        ],
      },
    },
  };

  /** What each end resolves. One function, because that is now the fix. */
  const definitionFor = (groupId, exerciseId) =>
    resolveWeek(canonical, forks, groupId, "w03").exercises.find(
      (x) => x.id === exerciseId,
    ) ?? null;

  // AN UNFORKED GROUP: byte-identical to the canonical, which is the property
  // that keeps the overwhelmingly common path unchanged.
  assert.equal(definitionFor("grpB", "x1").responseType, "text");
  assert.equal(definitionFor("grpB", "x2"), null);
  assert.equal(definitionFor("grpB", "x9").responseType, "text");
  assert.equal(definitionFor(null, "x1").responseType, "text");

  // A FORKED GROUP: the three divergences, now agreed on both ends.
  assert.equal(definitionFor("grpA", "x1").responseType, "link");
  assert.notEqual(definitionFor("grpA", "x2"), null); // the added one submits
  assert.equal(definitionFor("grpA", "x9"), null); // the removed one is refused

  // …and what the OLD route did, so the failure is on the record rather than
  // in a commit message: it validated a forked member against the canonical.
  const oldRouteSaw = (exerciseId) =>
    canonical.w03.exercises.find((x) => x.id === exerciseId) ?? null;
  assert.equal(oldRouteSaw("x2"), null); // → 404, and the answer is LOST
  assert.notEqual(oldRouteSaw("x9"), null); // → still accepts posts
  assert.notEqual(
    oldRouteSaw("x1").responseType,
    definitionFor("grpA", "x1").responseType, // → rejects against an unseen definition
  );

  // THE SOURCE, both ends. The member's own placement, off the enrolment row
  // the access gate already read — never a caller parameter.
  assert.match(SUBMIT, /from "@\/lib\/courses\/groupResolve"/);
  assert.match(
    SUBMIT,
    /const \{ week \} = await resolveWeekDoc\(db, runId, enrolment\.groupId, weekId\);/,
  );
  assert.doesNotMatch(
    SUBMIT,
    /\.collection\("courseRuns"\)/,
    "the submit route reads a run week directly again",
  );
  // The review queue already resolved group-first; BOTH ends now name the same
  // helper with the same arguments, which is what "they agree" means here.
  assert.match(GROUP_EXERCISES, /resolveWeekDoc\(db, group\.runId, groupId, weekId\)/);

  // my-exercises needs no resolution and must not grow one: it returns the
  // member's own stored ROWS and validates no definition at all, so a week
  // read there would be a cost with no question attached. Pinned so "make it
  // group-aware too" is a decision rather than a reflex.
  assert.doesNotMatch(MY_EXERCISES, /collection\("weeks"\)|resolveWeekDoc/);
  assert.match(MY_EXERCISES, /\.where\("weekNumber", "==", week\)/);
});

test("GUARD — virtual/in-person reaches the member, on the card and in the email", () => {
  // THE BUG: `sessionModes` was written by the session route, audited in the
  // rules, prefilled into the notice composer — and read by no member-facing
  // surface at all. `sessionForWeek` STRIPS `mode`, the overview payload
  // carried none, the card showed the room AND the join button unconditionally,
  // and the nudge named the room on a week the group met online. Meanwhile the
  // facilitator editor promised, in as many words, that the switch changes what
  // the group sees.

  // The storage → resolved shape, through the real normaliser: a mode with no
  // other override still CREATES one, because "meets online, same room field
  // untouched" is the normal state.
  const group = normalizeCourseGroup("grp1", {
    runId: "run1",
    session: {
      weekday: 2,
      startTimeLocal: "18:00",
      durationMinutes: 90,
      location: "Hallward B12",
      meetingUrl: "https://meet.example/naisi",
      notes: "",
    },
    sessionModes: { w03: "virtual", w04: "in-person" },
  });
  assert.equal(sessionModeForWeek(group, "w03"), "virtual");
  assert.equal(sessionModeForWeek(group, "w04"), "in-person");
  // Never set is NOT "in-person" — the distinction is what makes the card's
  // silent (legacy) state reachable and the clear-back action meaningful.
  assert.equal(sessionModeForWeek(group, "w05"), null);
  // …and the merged slot is unchanged by any of it, so every existing consumer
  // of `sessionForWeek` still gets exactly `GroupSession`.
  assert.equal(sessionForWeek(group, "w03").location, "Hallward B12");
  assert.equal(sessionForWeek(group, "w03").mode, undefined);

  // ── THE EMAIL LANE ────────────────────────────────────────────────────────
  const session = sessionForWeek(group, "w03");
  // Legacy (no mode): the room, exactly as before.
  assert.equal(courseNudgeSessionWhere(session), "Hallward B12");
  assert.equal(courseNudgeSessionWhere(session, null), "Hallward B12");
  // Virtual: "online", NOT the room — the whole finding, in one assertion.
  assert.equal(courseNudgeSessionWhere(session, "virtual"), "Online");
  assert.equal(courseNudgeSessionWhere(session, "in-person"), "Hallward B12");
  // A group with a STANDING meet link and no room: the legacy fallback says
  // "Online", but an explicit in-person week must not — that group's
  // facilitator has said people are meeting somewhere, and naming the video
  // call would send them to it.
  const linkOnly = { ...session, location: "" };
  assert.equal(courseNudgeSessionWhere(linkOnly), "Online");
  assert.equal(courseNudgeSessionWhere(linkOnly, "in-person"), "");
  // Neither → "", which drops the whole sentence rather than dangling it.
  assert.equal(courseNudgeSessionWhere({ ...linkOnly, meetingUrl: null }), "");
  // NEVER the URL, mode or no mode — email is the most forwardable surface we
  // have, and this is the assertion that keeps it that way.
  for (const mode of [undefined, null, "virtual", "in-person"]) {
    assert.doesNotMatch(courseNudgeSessionWhere(session, mode), /meet\.example/);
  }
  // WHERE takes the mode; WHEN deliberately does NOT — a week that moves online
  // happens at the same hour on the same evening, so threading it through would
  // be a parameter with no effect, which is the kind of thing a later reader
  // "fixes" into one that has one. Pinned so the asymmetry reads as a decision.
  assert.match(
    NUDGE_EMAIL,
    /export function courseNudgeSessionWhere\(\s*session: GroupSession \| null \| undefined,\s*mode\?: GroupSessionMode \| null,\s*\): string \{/,
  );
  assert.match(
    NUDGE_EMAIL,
    /export function courseNudgeSessionWhen\(\s*session: GroupSession \| null \| undefined,\s*sessionDateKey\?: string \| null,\s*\): string \{/,
  );

  // ── THE WIRING ────────────────────────────────────────────────────────────
  // The payload carries the WHOLE MAP, not one resolved answer — see the
  // per-week test below for why that distinction is a bug fix and not a
  // refactor. The slot fields stay resolved for the current week.
  assert.match(OVERVIEW, /sessionModes: Record<string, GroupSessionMode>;/);
  assert.match(OVERVIEW, /const weekId = currentWeekId\(currentWeek\);/);
  assert.match(OVERVIEW, /sessionModes: sessionModesOf\(ownGroup\),/);
  // The facilitator's own group page builds the same shape and hands the card
  // the same week's entry, so the person who just flipped the switch sees what
  // their members will.
  assert.match(GROUP_PAGE, /sessionModes: sessionModesOf\(group\),/);
  assert.match(GROUP_PAGE, /mode=\{sessionModeForWeek\(group, weekId\)\}/);
  // The nudge resolves it for the group's OWN week address, not the run's.
  assert.match(
    NUDGE,
    /sessionWhere: courseNudgeSessionWhere\(\s*session,\s*sessionModeForWeek\(group, at\.weekId\),\s*\)/,
  );

  // THE CARD: the point is the SUPPRESSION, both directions.
  assert.match(
    SESSION_CARD,
    /const showLocation = mode !== "virtual" && Boolean\(group\.location\);/,
  );
  assert.match(
    SESSION_CARD,
    /const showJoin = mode !== "in-person" && Boolean\(meetingUrl\);/,
  );
  // Honest fallbacks rather than an empty card, in both directions.
  assert.match(SESSION_CARD, /Online this week — your facilitator will send the joining link\./);
  assert.match(SESSION_CARD, /In person this week — your facilitator will confirm the room\./);

  // THE PII GATE IS UNTOUCHED. `mode` is a display fact; it grants nobody the
  // meeting link, and this is the line that says so.
  assert.match(OVERVIEW, /meetingUrl: canSeeMeetingUrl \? session\.meetingUrl : null,/);
  assert.match(OVERVIEW, /const canSeeMeetingUrl =/);
});

test("GUARD — the week page shows the VIEWED week's mode, not the current week's", () => {
  // THE BUG, and it is the virtual/in-person promise inverted. The payload
  // resolved ONE mode — for the week the run home names, i.e. the CURRENT one
  // — and `WeekView` rendered it beside the VIEWED week's date. Open week 3
  // while week 5 is flagged virtual and the card dated to week 3's evening
  // announced "Online this week" and SUPPRESSED week 3's room, which is
  // precisely the "half the group goes to a room nobody is in" failure the
  // switch exists to prevent, pointed the other way.
  const group = normalizeCourseGroup("grp1", {
    runId: "run1",
    session: {
      weekday: 2,
      startTimeLocal: "18:00",
      durationMinutes: 90,
      location: "Hallward B12",
      meetingUrl: "https://meet.example/naisi",
      notes: "",
    },
    sessionModes: { w05: "virtual" },
  });

  // THE FIX IS THE MAP: every week answers for itself.
  const modes = sessionModesOf(group);
  assert.deepEqual(modes, { w05: "virtual" });

  // Viewing week 3 while the cohort sits on week 5 — the two answers differ,
  // which is the whole point, and a single resolved field could not express it.
  const viewed = modes[weekDocId(3)] ?? null;
  const current = modes[weekDocId(5)] ?? null;
  assert.equal(viewed, null); // week 3: no mode set → show the room
  assert.equal(current, "virtual"); // week 5: online → hide it
  assert.notEqual(viewed, current);
  // The value the old payload would have handed week 3's card, for the record.
  assert.equal(sessionModeForWeek(group, weekDocId(5)), "virtual");
  // …and the card's suppression really is driven by that value, so the two
  // weeks render differently rather than merely holding different data.
  assert.equal(viewed !== "virtual" && Boolean(group.session.location), true);
  assert.equal(current !== "virtual" && Boolean(group.session.location), false);

  // BOUNDED, by the constant the rules and the override map already share —
  // this map travels to every member of the group, so it may not be open-ended.
  const many = {};
  for (let n = 1; n <= 40; n += 1) many[weekDocId(n)] = "virtual";
  const wide = normalizeCourseGroup("grp2", { runId: "run1", sessionModes: many });
  const capped = Object.keys(sessionModesOf(wide));
  assert.equal(capped.length, GROUP_FIELD_LIMITS.maxSessionOverrides);
  // Deterministically, in week order — not in whatever key order the document
  // happened to arrive in, which would make the truncation unreproducible.
  assert.deepEqual(capped, [...capped].sort());
  assert.equal(capped[0], weekDocId(1));

  // A week with no mode contributes NO KEY, so `?? null` in the consumers is
  // the legacy "nothing set" state rather than a lookup to guess at — the
  // never-set / in-person distinction the card depends on survives the trip.
  const plainGroup = normalizeCourseGroup("grp3", { runId: "run1" });
  assert.deepEqual(sessionModesOf(plainGroup), {});
  assert.equal(sessionModesOf(plainGroup)[weekDocId(3)] ?? null, null);

  // NO PII RIDES ALONG. The map is week ids → two literal strings and nothing
  // else; in particular the meeting link stays behind its own gate.
  for (const value of Object.values(sessionModesOf(group))) {
    assert.ok(value === "virtual" || value === "in-person");
  }
  assert.doesNotMatch(JSON.stringify(sessionModesOf(group)), /meet\.example/);

  // ── THE THREE CALLERS ─────────────────────────────────────────────────────
  // The card takes ONE mode, as a REQUIRED prop, and no longer reads a field
  // off `group` — which is what made "which week is this card about?"
  // un-askable at the only place that knows the answer.
  assert.match(SESSION_CARD, /mode: GroupSessionMode \| null;/);
  assert.doesNotMatch(codeOf(SESSION_CARD), /group\.mode/);
  assert.doesNotMatch(OVERVIEW, /^\s*mode: GroupSessionMode \| null;$/m);
  // WeekView picks the VIEWED week…
  assert.match(
    WEEK_VIEW,
    /payload\.group\?\.sessionModes\[weekDocId\(weekNumber\)\] \?\? null/,
  );
  assert.match(WEEK_VIEW, /mode=\{viewedSessionMode\}/);
  // …the run home the CURRENT one, because its card is dated to the current
  // slot and must describe that session end to end.
  assert.match(RUN_HOME, /group\?\.sessionModes\[weekDocId\(cardWeekNumber\)\] \?\? null/);
  assert.match(RUN_HOME, /mode=\{cardSessionMode\}/);

  // THE NUDGE IS UNAFFECTED, and that is verified rather than assumed: it
  // always resolved per week from the group DOC (it has no payload to read),
  // and it must keep doing so rather than being pointed at this map.
  assert.match(
    NUDGE,
    /sessionWhere: courseNudgeSessionWhere\(\s*session,\s*sessionModeForWeek\(group, at\.weekId\),\s*\)/,
  );
  assert.doesNotMatch(NUDGE, /sessionModesOf/);
});

/**
 * `autonomyOf` from `AllocationBoard`, reproduced — pinned to the real one by
 * the source assertions in the test below, exactly as `renumber` is.
 */
const autonomyOf = (group) =>
  group
    ? {
        paceStartDate: group.paceStartDate,
        paceWeekPlan: group.paceWeekPlan,
        forkedWeekIds: group.forkedWeekIds,
      }
    : null;

/** An `AllocGroup` as the route now returns it. */
const allocGroup = (id, autonomy = {}) => ({
  id,
  name: id,
  capacity: null,
  sessionLabel: "Tuesdays 18:00–19:30",
  facilitatorNames: [],
  memberCount: 0,
  paceStartDate: null,
  paceWeekPlan: null,
  forkedWeekIds: [],
  ...autonomy,
});

test("GUARD — the allocation board's divergence note fires on the REAL payload", () => {
  // THE BUG: `autonomyOf` read the three fields through a `Partial<>` cast
  // while the route was still owed them. It type-checked, every column
  // answered "run canonical", and the disclosure the V2-3 red team asked for
  // could not fire for any input whatsoever. This test exercises the predicate
  // against the shape the route ACTUALLY returns, so the note is proven
  // reachable rather than proven to be mentioned in a file.
  const plain = allocGroup("grpA");
  const paced = allocGroup("grpB", { paceStartDate: addDaysToKey(START, 7) });
  const replanned = allocGroup("grpD", {
    paceWeekPlan: [...plainPlan(3), brk("Reading week"), ...plainPlan(5).slice(3)],
  });
  const forked = allocGroup("grpC", { forkedWeekIds: ["w03", "w04"] });

  // Silent on the common move, including out of the unallocated pool (null).
  assert.deepEqual(groupsDiverge(autonomyOf(plain), autonomyOf(plain)), {
    pace: false,
    content: false,
  });
  assert.deepEqual(groupsDiverge(autonomyOf(null), autonomyOf(plain)), {
    pace: false,
    content: false,
  });
  // …and LOUD on every real divergence, in both directions, by lane.
  for (const other of [paced, replanned]) {
    assert.deepEqual(groupsDiverge(autonomyOf(plain), autonomyOf(other)), {
      pace: true,
      content: false,
    });
    assert.deepEqual(groupsDiverge(autonomyOf(other), autonomyOf(plain)), {
      pace: true,
      content: false,
    });
  }
  assert.deepEqual(groupsDiverge(autonomyOf(plain), autonomyOf(forked)), {
    pace: false,
    content: true,
  });
  assert.deepEqual(groupsDiverge(autonomyOf(forked), autonomyOf(paced)), {
    pace: true,
    content: true,
  });

  // THE REGRESSION ITSELF, modelled: the old payload had no autonomy fields,
  // and the cast defaulted them — so a group that had forked every week in the
  // plan still compared EQUAL to the run canonical and the note stayed silent.
  const legacyRead = (g) =>
    g
      ? {
          paceStartDate: g.paceStartDate ?? null,
          paceWeekPlan: g.paceWeekPlan ?? null,
          forkedWeekIds: g.forkedWeekIds ?? [],
        }
      : null;
  const legacyPayloadGroup = {
    id: "grpE",
    name: "E",
    capacity: null,
    sessionLabel: "",
    facilitatorNames: [],
    memberCount: 0,
  };
  assert.deepEqual(groupsDiverge(legacyRead(legacyPayloadGroup), null), {
    pace: false,
    content: false,
  });

  // THE PAYLOAD, at the source. Declared on the wire type AND populated.
  assert.match(ALLOCATION, /paceStartDate: string \| null;/);
  assert.match(ALLOCATION, /paceWeekPlan: WeekPlanEntry\[\] \| null;/);
  assert.match(ALLOCATION, /forkedWeekIds: string\[\];/);
  assert.match(ALLOCATION, /paceStartDate: g\.paceStartDate,/);
  assert.match(ALLOCATION, /paceWeekPlan: g\.paceWeekPlan,/);
  assert.match(ALLOCATION, /forkedWeekIds: forkedIdsByGroup\.get\(g\.id\) \?\? \[\],/);
  // IDS ONLY — a keys-only `select()` read, so no week content crosses onto a
  // board that non-admin track leads can open.
  assert.match(ALLOCATION, /\.select\(\)/);
  assert.doesNotMatch(ALLOCATION, /normalizeCourseWeek/);
  // The client type mirrors the wire type, or the board is back to guessing.
  assert.match(USE_ALLOCATION, /forkedWeekIds: string\[\];/);

  // …and the cast is GONE. This is the assertion that would have caught it.
  assert.match(ALLOCATION_BOARD, /paceStartDate: group\.paceStartDate,/);
  assert.match(ALLOCATION_BOARD, /forkedWeekIds: group\.forkedWeekIds,/);
  assert.doesNotMatch(
    ALLOCATION_BOARD,
    /Partial<GroupDivergenceInput>/,
    "the board reads the autonomy fields through a cast again — the note is dead",
  );
});

test("GUARD — the divergence note is worded by DIRECTION, all three of them", () => {
  // THE BUG: `groupsDiverge` is SYMMETRIC by design — it answers "does this
  // move cross a boundary", not "which side is the unusual one" — and the note
  // attributed every crossing to the TARGET unconditionally. So moving someone
  // OUT of a forked, re-paced group and back to the unallocated pool read:
  //
  //   "Unallocated runs on its own schedule and has its own version of some
  //    weeks, unlike Group B — … progress is counted against Unallocated's
  //    weeks from now on."
  //
  // Three falsehoods about a column that is BY DEFINITION the run canonical,
  // and it fired on the single most ordinary corrective action on the board.
  const labels = { source: "Group A", target: "Group B", who: "Ada" };
  const forked = { paceStartDate: null, paceWeekPlan: null, forkedWeekIds: ["w03"] };
  const paced = {
    paceStartDate: addDaysToKey(START, 7),
    paceWeekPlan: null,
    forkedWeekIds: [],
  };
  const canonical = { ...RUN_CANONICAL };

  // ── SILENT when nothing changes, in every combination of nulls ────────────
  assert.equal(divergenceNote(canonical, canonical, labels), null);
  assert.equal(divergenceNote(null, null, labels), null);
  assert.equal(divergenceNote(null, canonical, labels), null);
  assert.equal(
    divergenceNote(canonical, null, { ...labels, target: null }),
    null,
  );

  // ── DIRECTION 1: the TARGET diverges. The original copy, preserved ────────
  const intoDiverged = divergenceNote(canonical, forked, labels);
  assert.match(intoDiverged, /^Group B has its own version of some weeks, unlike Group A — /);
  assert.match(intoDiverged, /Ada may see different week numbers, dates and materials there/);
  assert.match(intoDiverged, /progress is counted against Group B's weeks from now on\.$/);
  // The pace lane words itself separately, because the two facts have
  // different consequences.
  assert.match(
    divergenceNote(canonical, paced, labels),
    /^Group B runs on its own schedule, unlike Group A — /,
  );
  assert.match(
    divergenceNote(canonical, { ...paced, forkedWeekIds: ["w03"] }, labels),
    /^Group B runs on its own schedule and has its own version of some weeks, unlike Group A — /,
  );

  // ── DIRECTION 2: only the SOURCE diverges — the sentence that was lying ───
  // Into the pool, which is the reported case. The pool is NEVER described as
  // having a schedule or weeks of its own.
  const toPool = divergenceNote({ ...paced, forkedWeekIds: ["w03"] }, null, {
    ...labels,
    target: null,
  });
  assert.equal(
    toPool,
    "Ada is leaving Group A's customised schedule and content — " +
      "the course curriculum applies from now on.",
  );
  assert.doesNotMatch(toPool, /Unallocated|own schedule|own version|'s weeks/);
  // Into an ordinary group that has overridden nothing: same shape, and the
  // destination is named because it exists.
  assert.equal(
    divergenceNote(forked, canonical, labels),
    "Ada is leaving Group A's customised content — " +
      "Group B's weeks and dates apply from now on.",
  );
  // One lane only, worded as one lane only.
  assert.equal(
    divergenceNote(paced, canonical, { ...labels, target: null }),
    "Ada is leaving Group A's customised schedule — " +
      "the course curriculum applies from now on.",
  );

  // ── DIRECTION 3: BOTH sides diverge — both clauses, source first ──────────
  const both = divergenceNote(forked, paced, labels);
  assert.equal(
    both,
    "Ada is leaving Group A's customised content, and Group B runs on its own " +
      "schedule — they may see different week numbers, dates and materials " +
      "there, and progress is counted against Group B's weeks from now on.",
  );
  // The mover is named ONCE and then pronominalised — the combined sentence
  // said "Ada … Ada" otherwise.
  assert.equal(both.match(/Ada/g).length, 1);

  // ── THE SYMMETRIC PREDICATE IS STILL THE GATE ────────────────────────────
  // Two groups holding the IDENTICAL pace override both diverge from the run,
  // but nothing about the mover's schedule changes — so the pace lane must
  // stay unworded even though `groupsDiverge(null, x)` flags both sides.
  assert.deepEqual(groupsDiverge(paced, paced), { pace: false, content: false });
  assert.equal(divergenceNote(paced, paced, labels), null);
  // …and with a fork on one side only, the note talks about content and is
  // silent about the schedule the two groups genuinely share.
  const sharedPace = divergenceNote({ ...paced, forkedWeekIds: ["w03"] }, paced, labels);
  assert.match(sharedPace, /customised content/);
  assert.doesNotMatch(sharedPace, /schedule/);

  // The bulk path's plural subject flows through unchanged.
  assert.match(
    divergenceNote(canonical, forked, { ...labels, who: "those 3 people" }),
    /those 3 people may see different week numbers/,
  );

  // ── THE WIRING ────────────────────────────────────────────────────────────
  // The board supplies LABELS and nothing else — in particular `target: null`
  // for the pool, which is how the helper knows not to describe a column with
  // no weeks as though it had some.
  assert.match(
    ALLOCATION_BOARD,
    /target: toColumnId === UNALLOCATED \? null : columnNameOf\(toColumnId\),/,
  );
  assert.match(ALLOCATION_BOARD, /source: columnNameOf\(fromColumnId\),/);
  // The helper computes per SIDE, which is the fix in one line of source.
  assert.match(GROUP_RESOLVE, /const fromOwn = groupsDiverge\(null, from\);/);
  assert.match(GROUP_RESOLVE, /const toOwn = groupsDiverge\(null, to\);/);
  // …and still gates on the symmetric answer first.
  assert.match(GROUP_RESOLVE, /const crossing = groupsDiverge\(from, to\);/);
});

test("GUARD — progress denominators come from the GROUP's week definitions", () => {
  // THE BUG (decision 6): `useRunWeekItems` counted items out of
  // `courseRuns/{runId}/weeks` while the TITLE on the same row came from the
  // overview's fork-overlaid index — so a member whose facilitator had swapped
  // a week's materials read their own week's title above the run's item count.
  // Decision 6 is explicit that a denominator is the group's current
  // definition, which is also what the fork PATCH route's orphan warning leans
  // on when it tolerates orphaned rows.
  const canonicalWeek = {
    id: "w03",
    weekNumber: 3,
    materials: [
      { id: "m1", optional: false },
      { id: "m2", optional: false },
      { id: "m3", optional: true },
    ],
    checklist: [{ id: "c1" }],
  };
  // The facilitator dropped one reading and added two of their own.
  const forkedWeek = {
    id: "w03",
    weekNumber: 3,
    materials: [
      { id: "m1", optional: false },
      { id: "f1", optional: false },
      { id: "f2", optional: false },
    ],
    checklist: [{ id: "c1" }],
  };
  const countable = (week) => [
    ...week.materials.filter((m) => !m.optional).map((m) => m.id),
    ...week.checklist.map((c) => c.id),
  ];

  // Optional materials stay out of BOTH denominators — that is the meaning of
  // the flag, not a choice this page makes.
  assert.deepEqual(countable(canonicalWeek), ["m1", "m2", "c1"]);
  assert.deepEqual(countable(forkedWeek), ["m1", "f1", "f2", "c1"]);

  // The overlay is BY DOC ID, the same rule `resolveWeekDocs` uses server-side
  // for the overview's own index — which is what makes the count and the title
  // on one row describe one document.
  const byId = new Map([[canonicalWeek.id, canonicalWeek]]);
  byId.set(forkedWeek.id, forkedWeek);
  assert.equal(countable(byId.get("w03")).length, 4);
  // A member who has ticked m1 and c1 reads 2 of 4 against their own week —
  // not 2 of 3 against a week nobody in their group was given.
  assert.notEqual(countable(canonicalWeek).length, countable(forkedWeek).length);

  // THE SOURCE. Both collections, overlaid by id, keyed on the group.
  assert.match(PROGRESS_BODY, /collection\(db, "courseRuns", runId, "weeks"\)/);
  assert.match(PROGRESS_BODY, /collection\(db, "courseGroups", groupId, "weeks"\)/);
  assert.match(PROGRESS_BODY, /byId\.set\(doc\.id, normalizeCourseWeek\(doc\.id, doc\.data\(\)\)\)/);
  // The CHEAPER of the two honest fixes, pinned as a decision: the overview
  // already says which weeks are forked, so an unforked group pays for no
  // extra read at all.
  assert.match(
    PROGRESS_BODY,
    /const hasForks = Boolean\(groupId\) && \(source\?\.forkedWeekIds\.length \?\? 0\) > 0;/,
  );
  assert.match(PROGRESS_BODY, /forkedWeekIds: overview\.data\.forkedWeekIds,/);
  // …and it waits for the overview rather than counting the run's items first
  // and swapping the numbers under the reader (the `useWeek` rule).
  assert.match(PROGRESS_BODY, /if \(!key \|\| state\.key !== key\) \{/);
});

test("GUARD — nothing outside the allowlist calls currentWeekFor, anywhere in src", () => {
  // THE WIDENING. The previous version of this guard checked four named files
  // and the group home page and the review page simply were not among them —
  // both paced their surfaces off `access.run` for the whole of V2-3, and no
  // test noticed. A guard whose coverage is a hand-maintained file list fails
  // exactly when someone adds a file, which is the moment it is needed.
  //
  // So: the WHOLE `src` tree, with an explicit allowlist. Adding a call site is
  // now a deliberate act with a line in this array and a reason beside it.
  //
  // THE LIST GOT SHORTER, which is the direction it should move: the allocate
  // route came off it when placement stopped stamping `joinedWeekNumber` from
  // the run's anchor and started resolving each member's own group instead.
  const ALLOWED = new Map([
    ["lib/courses/weekPlan.ts", "the definition"],
    ["lib/courses/groupResolve.ts", "THE wrapper — `memberCurrentWeek` is this call, group-aware"],
    [
      "app/api/courses/runs/[runId]/nudge/route.ts",
      "the send TRIGGER is run-level by design (one send, one claim, one record)",
    ],
    [
      "features/courses/GroupPaceEditor.tsx",
      "previews the DRAFT calendar the facilitator is typing — its inputs are " +
        "the group's own start date and plan, not the run's",
    ],
    [
      "features/courses/WeekPlanBuilder.tsx",
      "the admin's run-plan preview — the RUN is its subject",
    ],
  ]);

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC);
  // The walk has to be finding the tree, or this test passes by looking at
  // nothing at all.
  assert.ok(files.length > 200, `only ${files.length} source files found`);

  // ── THE DETECTOR ITSELF, PROVEN BEFORE IT IS TRUSTED ──────────────────────
  // A guard is only as good as its idea of "does this file call it", and this
  // one's had two holes wide enough to walk through by accident. Both are
  // exercised here as fixtures, both alongside the OLD detector, so the test
  // shows the evasion working before it shows it closed.
  const legacyDetect = (source) =>
    /\bcurrentWeekFor\s*\(/.test(
      source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""),
    );

  // EVASION 1 — a `//` inside a STRING. The old strip treated it as a comment
  // and ate the rest of the line, call included. Nobody would write this to
  // hide anything; someone would write it because a URL was handy.
  const stringEvasion =
    'console.warn("pacing: https://naisi.example/docs", currentWeekFor(run).weekNumber);\n';
  assert.equal(legacyDetect(stringEvasion), false, "fixture 1 no longer evades the old strip");
  assert.equal(callsCurrentWeekFor(stringEvasion), true);

  // EVASION 2 — an ALIASED import. The name match never sees the call at all,
  // so the ALIAS is the offence (chasing the local binding would need a module
  // graph; there is no legitimate reason to rename this function).
  const aliasEvasion =
    'import { currentWeekFor as anchorOf } from "@/lib/courses/weekPlan";\n' +
    "const anchor = anchorOf(run).anchorWeekNumber;\n";
  assert.equal(legacyDetect(aliasEvasion), false, "fixture 2 no longer evades the old strip");
  assert.equal(callsCurrentWeekFor(aliasEvasion), true);

  // …and the thing the stripping exists for in the first place still holds:
  // PROSE about the function, however emphatic, is not a call site.
  assert.equal(
    callsCurrentWeekFor(
      "// use memberCurrentWeek, never currentWeekFor(run) — and never\n" +
        "// import { currentWeekFor as anchorOf } either.\n" +
        "/* currentWeekFor(run) is the run's clock. */\n" +
        'const NOTE = "currentWeekFor(run)";\n' +
        "const anchor = memberCurrentWeek(run, group).anchorWeekNumber;\n",
    ),
    false,
  );
  // Template interpolation is real code inside a string, so a call written
  // there counts — the string scanner must come back out for `${…}`.
  assert.equal(callsCurrentWeekFor("const s = `week ${currentWeekFor(run).weekNumber}`;\n"), true);

  const offenders = [];
  for (const file of files) {
    // Comments name the function constantly and legitimately (this is a
    // documented codebase); only CODE is a call site.
    if (!callsCurrentWeekFor(readFileSync(file, "utf8"))) continue;
    const rel = relative(SRC, file).split("\\").join("/");
    if (!ALLOWED.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "these paced a surface off the run's own calendar — use `memberCurrentWeek(run, group)`",
  );

  // Every allowlist entry must still BE a call site, so the list cannot rot
  // into a set of names that stopped meaning anything. SAME detector as the
  // forward check, deliberately: two spellings of "calls it" is how an entry
  // ends up both allowed and unreachable.
  for (const rel of ALLOWED.keys()) {
    assert.ok(
      callsCurrentWeekFor(readFileSync(join(SRC, rel), "utf8")),
      `${rel} is allowlisted but no longer calls it`,
    );
  }

  // The two that escaped, now named: both resolve group-first.
  assert.match(GROUP_PAGE, /currentWeek = memberCurrentWeek\(access\.run, group\);/);
  assert.match(GROUP_REVIEW_PAGE, /const calendar = resolveCalendar\(access\.run, group\);/);
  assert.match(GROUP_REVIEW_PAGE, /const current = memberCurrentWeek\(access\.run, group\);/);
  assert.match(GROUP_REVIEW_PAGE, /calendar\.weekPlan\.flatMap\(/);
  for (const [source, name] of [
    [GROUP_PAGE, "the group home page"],
    [GROUP_REVIEW_PAGE, "the review page"],
  ]) {
    assert.match(source, /from "@\/lib\/courses\/groupResolve"/, `${name} skips the resolver`);
  }
});

test("GUARD — a pace change re-opens the mirror window it would otherwise wedge shut", () => {
  // THE BUG, as a transition. `lastTaskSyncedWeek` is monotonic BY DESIGN so
  // that an admin editing the RUN's calendar backwards cannot resurrect a card
  // a member dismissed. A FACILITATOR re-pacing their own group hits the same
  // machinery from the other side:
  //
  //   pace ahead → members mount → the mark stamps 8 → clear the pace → the
  //   group is back on week 3 → weeks 3-7 sit BELOW every mark and never
  //   mirror again.
  const AHEAD = 8;
  const REWOUND_ANCHOR = 3;
  const LAST_WEEK = 8;

  /** The pace route's reset value: ONE BELOW the new anchor, clamped at 0. */
  const resetOf = (anchor) => Math.max(0, anchor - 1);

  /** Walk a group forward from `from` to `LAST_WEEK`, mirroring as it goes. */
  const walk = (startMark, from = REWOUND_ANCHOR) => {
    let mark = startMark;
    const delivered = [];
    for (let anchor = from; anchor <= LAST_WEEK; anchor += 1) {
      if (alreadyDelivered(mark, anchor)) continue;
      delivered.push(anchor);
      mark = anchor;
    }
    return delivered;
  };

  // BEFORE THE FIX: the mark is 8, so the whole rewound term delivers NOTHING.
  assert.deepEqual(walk(AHEAD), []);
  for (let week = REWOUND_ANCHOR; week <= LAST_WEEK; week += 1) {
    assert.equal(alreadyDelivered(AHEAD, week), true);
  }

  // THE OFF-BY-ONE, as its own transition. Resetting the mark TO the new anchor
  // looked right and lost exactly one week — the anchor itself, which is the
  // week the group has just been rewound ONTO. `sync-tasks` short-circuits on
  // `mark >= weekNumber`, so a mark of 5 skips week 5.
  assert.equal(alreadyDelivered(REWOUND_ANCHOR, REWOUND_ANCHOR), true);
  assert.deepEqual(walk(REWOUND_ANCHOR), [4, 5, 6, 7, 8]); // week 3 missing
  // And that week was never delivered in the first place: a group paced ahead
  // to week 8 had week 8 mirrored on the mount that stamped the mark, and
  // weeks 3-7 never. The mark says "8" and means "8", not "1 through 8".
  assert.equal(alreadyDelivered(AHEAD, LAST_WEEK), true);

  // AFTER THE FIX: the route winds the mark down to ONE BELOW the new anchor,
  // so the group's re-lived term delivers again — starting with the week it is
  // actually on, each week exactly once, in order.
  assert.deepEqual(walk(resetOf(REWOUND_ANCHOR)), [3, 4, 5, 6, 7, 8]);

  // THE REPORTED CASE: repace 8 → 5 must deliver week 5.
  const MID_ANCHOR = 5;
  assert.deepEqual(walk(resetOf(MID_ANCHOR), MID_ANCHOR), [5, 6, 7, 8]);
  assert.equal(alreadyDelivered(resetOf(MID_ANCHOR), MID_ANCHOR), false);
  // …which the pre-fix reset did not.
  assert.equal(alreadyDelivered(MID_ANCHOR, MID_ANCHOR), true);

  // CLAMPED AT 0 — the absent-mark default — so a rewind all the way to week 1
  // delivers week 1 rather than reaching for a mark of 0-minus-one.
  assert.equal(resetOf(1), 0);
  assert.equal(alreadyDelivered(0, 1), false);
  assert.equal(alreadyDelivered(undefined, 1), false);

  // DOWN ONLY, and the filter is UNCHANGED by the −1: a mark at or below the
  // new anchor belongs to a member who genuinely has not been over-delivered,
  // and raising it would swallow the weeks they are still owed. A member whose
  // mark IS the new anchor really did receive that week, so they are not
  // rewound and week 5 is not sent twice.
  const below = 1;
  assert.ok(below <= REWOUND_ANCHOR);
  assert.deepEqual(walk(below), [3, 4, 5, 6, 7, 8]);
  assert.equal(MID_ANCHOR > MID_ANCHOR, false); // the route's `mark > nextAnchor`

  // THE DETERMINISTIC-ID INTERACTION, verified rather than assumed. A
  // re-mirrored week aims at the SAME document id it aimed at the first time…
  assert.equal(
    courseTaskId("run1", 5, "u1"),
    courseTaskId("run1", 5, "u1"),
  );
  assert.notEqual(courseTaskId("run1", 5, "u1"), courseTaskId("run1", 6, "u1"));
  // …and the mirror only ever `.create()`s, treating ALREADY_EXISTS as
  // `alreadyPresent` and overwriting nothing. So for a card the member KEPT,
  // the re-mirror is a true no-op. (For one they DISMISSED the document was
  // DELETED — the rules permit exactly that — so it comes back; the route
  // header states that plainly as the one behaviour this reset changes, and it
  // is the correct reading of a facilitator rewinding their group's term.)
  assert.match(SYNC_TASKS, /await taskRef\.create\(payload\)/);
  assert.doesNotMatch(SYNC_TASKS, /taskRef\.(update|delete|set)\(/);
  assert.match(SYNC_TASKS, /alreadyPresent = 1;/);

  // THE SOURCE. Bounded by group size, DOWN only, and in the SAME transaction
  // as the pace write — a group cannot be left re-paced with its members'
  // marks still describing the calendar it left.
  assert.match(PACE, /\.where\("status", "==", "active"\)\s*\.limit\(MAX_GROUP_MEMBERS\)/);
  assert.match(PACE, /memberCurrentWeek\(run, nextPace\)\.anchorWeekNumber/);
  assert.match(PACE, /\(enrolment\.lastTaskSyncedWeek \?\? 0\) > nextAnchor/);
  // ONE BELOW, clamped — the two halves of the off-by-one fix, in the two
  // lines that carry it. The write must not go back to `nextAnchor`.
  assert.match(
    PACE,
    /const resetMark = nextAnchor === null \? null : Math\.max\(0, nextAnchor - 1\);/,
  );
  assert.match(PACE, /tx\.update\(doc\.ref, \{ lastTaskSyncedWeek: resetMark \}\)/);
  assert.doesNotMatch(
    codeOf(PACE),
    /lastTaskSyncedWeek: nextAnchor\b/,
    "the reset is back on the anchor — the new anchor week never mirrors",
  );
  // The reads are all inside the transaction, before any write — the shape the
  // strand gate already required.
  assert.match(PACE, /tx\.get\(\s*db\s*\.collection\("courseEnrolments"\)/);
  // A calendar with no usable start date resolves no anchor, so the marks are
  // left alone rather than reset to a number this route cannot compute.
  assert.match(PACE, /isValidDateKey\(nextCalendar\.startDate\)\s*\?/);
  assert.match(PACE, /nextAnchor === null/);
});

test("GUARD — a retrospective note can be written about a fork-only material", () => {
  // THE BUG: the note route scanned `courseRuns/{runId}/weeks` alone, so a
  // facilitator could not record how their OWN swapped-in reading landed — the
  // exact lane the retrospective exists for — and got told the material "isn't
  // in this run's curriculum", which from their side was simply false.
  //
  // The scan is now ORDERED and short-circuiting: the actor's own groups'
  // forks, then the canonical, then (trusted tier only) everyone else's.
  const ownFirst = MATERIAL_NOTES.indexOf("...ownGroupIds.map(");
  const canonical = MATERIAL_NOTES.indexOf(
    '() => db.collection("courseRuns").doc(runId).collection("weeks")',
  );
  const others = MATERIAL_NOTES.indexOf("...(isTrusted");
  assert.ok(ownFirst > -1 && canonical > -1 && others > -1, "the scan list is no longer a list");
  assert.ok(ownFirst < canonical, "the actor's own forks are no longer scanned first");
  assert.ok(canonical < others, "other groups' forks are no longer the last resort");

  assert.match(
    MATERIAL_NOTES,
    /db\.collection\("courseGroups"\)\.doc\(gid\)\.collection\("weeks"\)/,
  );
  // Short-circuiting, so the common case (a canonical material, a facilitator
  // with one room) is two collection reads and the tail is never walked.
  assert.match(MATERIAL_NOTES, /if \(found\) break;/);

  // A PLAIN FACILITATOR GETS NO REACH into a room they do not staff — the same
  // boundary the review queue draws. Only the trusted tier scans the rest.
  assert.match(MATERIAL_NOTES, /isTrusted\s*\?\s*otherGroupIds\.map\(/);
  assert.match(MATERIAL_NOTES, /const isTrusted =/);
  assert.match(MATERIAL_NOTES, /asUidList\(runRaw\.trackLeadUids\)\.includes\(actor\.uid\)/);
  // The split that feeds it, and the bound it inherits.
  assert.match(MATERIAL_NOTES, /const ownGroupIds: string\[\] = \[\];/);
  assert.match(MATERIAL_NOTES, /\.limit\(MAX_GROUPS_SCANNED\)/);

  // `weekNumber` is still SERVER-DERIVED from wherever the material was found —
  // the property the whole scan exists to keep true.
  assert.match(MATERIAL_NOTES, /const claimedWeek = body\.weekNumber;/);
  assert.match(MATERIAL_NOTES, /weekNumber = week\.weekNumber;/);
  // Still ONE indistinguishable 403 for "no such run" and "not yours".
  assert.equal((MATERIAL_NOTES.match(/error: "Forbidden"/g) ?? []).length, 1);
});

test("GUARD — sanitizeMaterials rebuilds key-by-key, so nothing rides into a fork", () => {
  // THE BUG: the sanitiser spread its input (`{ ...m }`), so unknown keys
  // survived. Harmless while every writer was a client-direct save the rules
  // bound — and NOT harmless once the group-week PATCH route began running
  // arbitrary request bodies through the same function on their way into a
  // document whose only ceiling is Firestore's 1 MB.
  const [material] = sanitizeMaterials([
    {
      id: "m1",
      type: "reading",
      title: "Goal misgeneralisation",
      url: "https://example.org/paper",
      author: "Langosco et al.",
      optional: true,
      estimatedMinutes: 25.4,
      // The passengers.
      guideBlocks: [{ id: "b1", type: "richText", html: "x".repeat(5000) }],
      weekNumber: 3,
      junk: "…",
    },
  ]);
  assert.deepEqual(Object.keys(material).sort(), [
    "author",
    "estimatedMinutes",
    "id",
    "optional",
    "title",
    "type",
    "url",
  ]);
  assert.equal(material.estimatedMinutes, 25);
  assert.equal(material.optional, true);

  // Every type keeps its own payload and nothing else. Optional fields stay
  // ABSENT rather than `undefined` — Firestore refuses `undefined`.
  const [video] = sanitizeMaterials([
    { id: "m2", type: "video", title: "V", url: "https://youtu.be/dQw4w9WgXcQ", extra: 1 },
  ]);
  assert.deepEqual(Object.keys(video).sort(), ["id", "optional", "title", "type", "url"]);
  const [note] = sanitizeMaterials([
    { id: "m3", type: "note", title: "N", body: "Aside", extra: 1 },
  ]);
  assert.deepEqual(Object.keys(note).sort(), ["body", "id", "optional", "title", "type"]);
  const [link] = sanitizeMaterials([
    { id: "m4", type: "link", title: "L", url: "https://x.test", description: "", extra: 1 },
  ]);
  assert.equal("description" in link, false);

  // EVERY EXISTING CALLER STILL PASSES, and the one that would notice is the
  // group-week PATCH: it refuses when the sanitiser SHRINKS the array, so a
  // rebuild that dropped a row would read as "one or more materials are
  // malformed" on a save that used to work. It drops no rows the spread kept.
  const rows = [
    { id: "a", type: "reading", title: "A", url: "https://a.test" },
    { id: "b", type: "video", title: "B", url: "https://youtu.be/dQw4w9WgXcQ" },
    { id: "c", type: "link", title: "C", url: "https://c.test" },
    { id: "d", type: "note", title: "D", body: "d" },
  ];
  assert.equal(sanitizeMaterials(rows).length, rows.length);
  assert.match(GROUP_WEEK_PATCH, /materials\.length !== body\.materials\.length/);
  // …and it still filters what it always filtered: a video whose URL has no
  // parseable YouTube id is not a material this renderer can show.
  assert.equal(
    sanitizeMaterials([{ id: "e", type: "video", title: "E", url: "https://vimeo.com/1" }]).length,
    0,
  );

  // The shape of the fix, at the source — no spread, keys named.
  const body = /export function sanitizeMaterials[\s\S]*?\n}\n/.exec(COURSES_LIB)[0];
  assert.doesNotMatch(body, /\{\s*\.\.\.m\b/, "sanitizeMaterials spreads its input again");
  assert.match(body, /id: m\.id,/);
  assert.match(body, /title: m\.title,/);
});

test("GUARD — the room-notice cap warning has a number to show", () => {
  // THE BUG: `RoomNoticeComposer` renders `payload.remaining` and the notice
  // route never returned it, so the "2 of today's 10 notices left" warning
  // could not appear — a facilitator's first sight of the cap was the refusal.
  assert.match(ROOM_NOTICE, /typeof payload\.remaining === "number" \? payload\.remaining : null/);
  assert.match(ROOM_NOTICE, /notices left for this group/);
  assert.match(NOTICE, /remaining: slot\.remaining/);

  // It comes out of the CLAIM, not a re-read: the transaction is the only
  // place that has seen the committed count.
  assert.match(FACILITATOR_EMAILS, /remaining: Math\.max\(0, args\.limit - claimed\)/);
  assert.match(FACILITATOR_EMAILS, /const claimed = inWindow \? count \+ 1 : 1;/);
  // A refusal reports zero left, which is what a refusal means.
  assert.match(FACILITATOR_EMAILS, /retryAfterSeconds: Math\.max\(\s*1,[\s\S]{0,120}?remaining: 0,/);
  // The early "nobody to send to" returns spend no slot, so they honestly carry
  // no `remaining` and the composer reads that as "unknown" rather than 0.
  assert.match(NOTICE, /return NextResponse\.json\(\{ ok: true, sent: 0, skipped \}\);/);
});

test("GUARD — the notice lane's audit kind is a real member of EmailSendKind", () => {
  // Decision 8's audit trail IS the `emailSends` rows, and the kind was cast
  // past a closed union — which would have kept compiling through a rename or
  // a re-owning of the union, leaving the one un-opt-out-able course lane
  // logging under a string nothing recognises.
  assert.match(EMAIL_SENDS, /\| "course-notice"/);
  assert.match(NOTICE, /const NOTICE_KIND: EmailSendKind = "course-notice";/);
  assert.doesNotMatch(NOTICE, /as EmailSendKind/, "the audit kind is cast past the union again");
  // Its own kind, not folded into the facilitator lane — the two answer
  // different questions in the deliverability tab.
  assert.match(EMAIL_SENDS, /\| "course-facilitator"/);
  assert.match(NOTICE, /referenceId: groupId,/);
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
