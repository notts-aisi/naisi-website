/**
 * Unit tests for the V2-1 DELETION PROTOCOL — the planning half of DESTROY.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * A destroy is the one operation in this codebase that cannot be undone by
 * pressing something else. `accountDeletion.ts` earned its paragraphs the hard
 * way — an ordering rationale, a drained-throw guard, a step SKIPPED OUTRIGHT
 * when its predecessor fails — and none of it was executable. This cascade is
 * bigger (ten collections, a shared document budget, a resume cursor living on
 * the doomed document itself) and it is driven by an ADMIN reading numbers on a
 * screen. So the parts that can be pinned without a database are pinned here:
 *
 *  - manifest count assembly — the numbers read immediately before the point
 *    of no return, and the fates that say which of them actually die;
 *  - cascade step ORDER — leaf before index, asserted at the SOURCE;
 *  - page-budget arithmetic — the difference between "resume me" and
 *    "I am finished", which is the whole resumability contract;
 *  - the blocker predicates — the sentences standing between an operator and
 *    a live cohort;
 *  - byte-equality of `confirmName` — the last gate, worth nothing if it is
 *    anything less than exact.
 *
 * **The cascade engine is exercised ONLY here and in the rules emulator.**
 * Nothing in this file may reach a Firestore project or put mail on the wire.
 *
 * ## Three kinds of test, labelled
 *
 * **GUARD** — a property the code holds. Break it and the test goes red.
 *
 * **MODEL** — the rule reproduced here and PINNED to the source with an
 * assertion, the `course-schedule-changes.test.mjs` idiom. Neither the engine
 * nor the routes can be imported (`server-only`, `firebase-admin`,
 * `next/server`), so a model plus a pin is the only executable form the rule
 * has. If a pin fails the model has drifted from the code; do not "fix" it by
 * loosening the pin.
 *
 * **PROVEN GAP** — a disagreement between two halves of the feature that needs
 * a decision, not a patch. Following `candidate-findings.test.mjs`, these
 * assert the gap is STILL THERE so they fail the day it is closed. **When you
 * fix one, invert the assertion in the same commit.** There were three; all
 * three are closed, and §8 holds the inverted assertions — each still carrying
 * the decision that was made, so the reasoning stays attached to the guard
 * rather than disappearing with the gap. §9 pins the review findings that
 * followed. A new gap belongs in a PROVEN GAP block of its own, and goes the
 * same way when it is answered.
 *
 * ## The loader dance
 *
 * Lifted from `course-nudge.test.mjs` / `course-schedule-changes.test.mjs`,
 * which already solved importing TypeScript from `.mjs` on this repo's Node
 * (v20, no native type stripping) including `@/…` aliases and stubbing
 * `server-only`.
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
    join(SRC, "lib", "email", "send.ts"),
    "export function sendEmail() {\n" +
      "  throw new Error('sendEmail is stubbed — a destroy is silent, and a unit test must not send mail');\n}",
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
      jsx: tsc.JsxEmit.ReactJSX,
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

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code, not a model.
// ---------------------------------------------------------------------------

const { COURSE_RUN_STATUSES, courseRunChannel, normalizeCourseRun } =
  await loadTs("lib/firestore/courses.ts");
const { countMeta, countRows, destroyedTotal, parseManifest, sumCounts } =
  await loadTs("features/courses/useDestroy.ts");

// ---------------------------------------------------------------------------
// Source handles for the parts that cannot be imported.
// ---------------------------------------------------------------------------

const src = (...parts) => readFileSync(join(SRC, ...parts), "utf8");
const api = (...parts) => src("app", "api", "courses", ...parts);

const ENGINE = src("lib", "firestore", "courseDeletion.ts");
const HOOK = src("features", "courses", "useDestroy.ts");

/**
 * The engine with its comments stripped. Several guards below assert that a
 * field is NOT read (`run.channel`), and this file's comments name those
 * fields constantly — so "does the code do X" has to be asked of the code.
 */
const ENGINE_CODE = ENGINE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const RUN_MANIFEST = api("runs", "[runId]", "destroy-manifest", "route.ts");
const RUN_DESTROY = api("runs", "[runId]", "destroy", "route.ts");
const RUN_ARCHIVE = api("runs", "[runId]", "archive", "route.ts");
const RUN_STATUS = api("runs", "[runId]", "status", "route.ts");
const RUN_APPLY = api("runs", "[runId]", "apply", "route.ts");
const ME_ROUTE = api("me", "route.ts");
const COURSE_MANIFEST = api("[courseId]", "destroy-manifest", "route.ts");
const COURSE_DESTROY = api("[courseId]", "destroy", "route.ts");

/** Client + server surfaces that owe the `archived` flag an answer (§8). */
const FETCHERS = src("features", "courses", "fetchCourses.ts");
const RUN_ACCESS = src("features", "courses", "runAccess.ts");
const ADMIN_RUNS_HOOK = src("features", "courses", "useAdminCourses.ts");
const COURSE_EDITOR = src("features", "courses", "CourseEditor.tsx");
const DASHBOARD_SUMMARY = src("features", "courses", "MyCoursesSummary.tsx");
const LEARN_HUB = src("app", "(app)", "learn", "page.tsx");
const RUN_ZONE = src("features", "courses", "RunDangerZone.tsx");
const COURSE_ZONE = src("features", "courses", "CourseDangerZone.tsx");

const ROUTES = [
  [RUN_MANIFEST, "run manifest"],
  [RUN_DESTROY, "run destroy"],
  [RUN_ARCHIVE, "run archive"],
  [COURSE_MANIFEST, "course manifest"],
  [COURSE_DESTROY, "course destroy"],
];

/** A numeric tuning constant declared in the engine. */
function engineConst(name) {
  const m = new RegExp(`\\b${name}\\b\\s*(?::\\s*number)?\\s*=\\s*(\\d+)`).exec(ENGINE);
  assert.ok(m, `the engine no longer declares ${name}`);
  return Number(m[1]);
}

/**
 * The cascade's stage table, sliced out of the engine by its declaration
 * rather than scraped from the whole file.
 *
 * The earlier version ran `/key: "(\w+)"/g` over the ENTIRE source, which
 * reads any `key: "…"` anywhere — a comment, a future helper, a second table —
 * as a cascade stage. That failure is silent in the dangerous direction: a
 * stray match anywhere ABOVE the table shifts every index, so the ordering
 * assertions in §2 (leaf before index, containers last) start comparing
 * positions in a list that is not the stage order and can pass while the real
 * order is wrong.
 */
const STAGE_TABLE = (() => {
  const start = ENGINE.indexOf("const stages: Array<");
  assert.notEqual(start, -1, "the cascade stage table is no longer a literal");
  const end = ENGINE.indexOf("\n  ];", start);
  assert.ok(end > start, "the cascade stage table is not closed where expected");
  return ENGINE.slice(start, end);
})();

/** The cascade's declared stage order, read out of that table alone. */
const STAGE_ORDER = [...STAGE_TABLE.matchAll(/key: "(\w+)"/g)].map((m) => m[1]);

// ===========================================================================
// §1 MANIFEST COUNT ASSEMBLY
//
// The numbers an operator reads immediately before typing a name they cannot
// untype. The two failure directions are not symmetrical: overstating what
// dies makes someone more careful than they needed to be; understating it
// lets them press the button believing something survives.
// ===========================================================================

/** `RunDestroyCounts`, mirrored. Pinned to the engine's type below. */
const RUN_COUNT_KEYS = [
  "weeks",
  "groups",
  "applications",
  "enrolments",
  "progress",
  "exerciseResponses",
  "attendanceRegisters",
  "mirroredTasks",
  "subscriptionRows",
  "emailSendRows",
];
/** `CourseDestroyCounts`, mirrored. */
const COURSE_COUNT_KEYS = ["runs", "templates"];

/** Counters whose rows SURVIVE the cascade — never part of the death toll. */
const SURVIVING_COUNT_KEYS = ["emailSendRows", "templates"];

test("MODEL — the manifest count vocabulary is the same on both sides of the wire", () => {
  // The engine declares the counts; the dialog renders them; the two files were
  // written separately and are joined only by these key names.
  const runType = /export type RunDestroyCounts = \{([\s\S]*?)\};/.exec(ENGINE);
  assert.ok(runType, "RunDestroyCounts is no longer a type literal");
  const declared = [...runType[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(declared, RUN_COUNT_KEYS);

  const courseType = /export type CourseDestroyCounts = \{([\s\S]*?)\};/.exec(ENGINE);
  assert.ok(courseType, "CourseDestroyCounts is no longer a type literal");
  assert.deepEqual(
    [...courseType[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]),
    COURSE_COUNT_KEYS,
  );

  // Every declared counter has copy and a fate in the dialog. A counter with
  // neither renders as a humanised key and is ASSUMED destroyed (see below) —
  // survivable, but it means an admin is reading a guess.
  for (const key of [...RUN_COUNT_KEYS, ...COURSE_COUNT_KEYS]) {
    const meta = countMeta(key);
    assert.ok(meta.label.length > 0, `${key} has no label`);
    assert.ok(["destroyed", "retained", "orphaned"].includes(meta.fate), `${key} has no fate`);
  }
});

test("GUARD — the survivors are not counted as deaths, and the arithmetic follows the fates", () => {
  // `emailSends` is the append-only record of what was sent to whom —
  // deliverability and abuse-handling evidence, not this run's to erase.
  // Templates are frozen append-only snapshots (v2 decision 2); destroying the
  // course they came from orphans them, it does not destroy them.
  for (const key of SURVIVING_COUNT_KEYS) {
    assert.notEqual(
      countMeta(key).fate,
      "destroyed",
      `${key} is reported as destroyed, but its rows survive the cascade`,
    );
  }
  const counts = Object.fromEntries(
    [...RUN_COUNT_KEYS, ...COURSE_COUNT_KEYS].map((k) => [k, 10]),
  );
  assert.equal(sumCounts(counts), 120);
  // The progress denominator counts only what actually dies, so a large
  // retained counter cannot inflate it into a bar that never fills.
  assert.equal(destroyedTotal(counts), 100);
});

test("MODEL — every key the cascade can report has copy, including the ones the manifest never shows", () => {
  // `deleted` carries stage keys the manifest has no counter for: `nudgeMarkers`
  // (send-dedupe machinery, hygiene) and the target document itself. They land
  // in the same receipt the manifest counters do, so they must not render as
  // raw identifiers in front of an admin.
  const stageKeys = STAGE_ORDER;
  assert.ok(stageKeys.length >= 10, "the cascade stage table is no longer literal");
  for (const key of [...stageKeys, "run", "courses"]) {
    const meta = countMeta(key);
    assert.match(meta.label, /^[A-Z]/, `${key} renders as "${meta.label}"`);
    assert.doesNotMatch(meta.label, /[a-z][A-Z]/, `${key} renders as an identifier`);
  }
  // The two directions of the manifest/receipt mismatch, stated explicitly so a
  // future counter has to choose a side rather than drift into one.
  assert.equal(stageKeys.includes("emailSendRows"), false, "emailSends must never be a stage");
  assert.equal(RUN_COUNT_KEYS.includes("nudgeMarkers"), false);
});

test("GUARD — counts are LIVE reads: a NaN counter is missing, never a zero", () => {
  // The contract is that the numbers are read at request time. A counter that
  // failed to read must not render as "0 enrolments" — that is the exact
  // sentence that would talk an operator past a live cohort.
  const parsed = parseManifest(
    {
      run: { id: "run1", label: "Autumn 2026", courseTitle: "AISF", status: "running" },
      counts: {
        enrolments: Number.NaN,
        progress: -4,
        weeks: "8",
        groups: 3.7,
        applications: 61,
      },
      blockers: [],
    },
    "fallback",
  );
  assert.equal("enrolments" in parsed.counts, false, "a NaN counter must be absent, not 0");
  assert.equal("progress" in parsed.counts, false, "a negative counter must be absent");
  assert.equal("weeks" in parsed.counts, false, "a string counter must be absent");
  assert.equal(parsed.counts.groups, 3);
  assert.equal(parsed.counts.applications, 61);
  // And the route really does count rows rather than reading the denormalised
  // per-status counters the admin list uses: `applicationCounts` can be stale,
  // and this is the one screen where a stale number is a lie with consequences.
  assert.match(ENGINE, /countAgg\(\s*\n?\s*db\s*\n?\s*\.collection\("courseApplications"\)/);
  assert.doesNotMatch(RUN_MANIFEST, /applicationCounts/);
});

test("GUARD — a zero counter is KEPT as a row: 0 registers is not the same as never looked", () => {
  const rows = countRows({ attendanceRegisters: 0, enrolments: 38 });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["enrolments", "attendanceRegisters"],
    "rows must render in the fixed display order, not input order",
  );
  assert.equal(rows[1].value, 0);
  // An unknown counter still gets a stable home rather than vanishing.
  assert.deepEqual(countRows({ enrolments: 1, zzz: 2, aaa: 3 }).map((r) => r.key), [
    "enrolments",
    "aaa",
    "zzz",
  ]);
});

test("GUARD — an UNKNOWN counter is assumed destroyed, the survivable direction", () => {
  const meta = countMeta("facilitatorNotes");
  assert.equal(meta.fate, "destroyed");
  assert.equal(meta.label, "Facilitator notes");
  // Aliases carry the fate with them, so a route that spells a counter
  // differently cannot silently turn a retained row into a reported deletion.
  assert.equal(countMeta("emailSends").fate, countMeta("emailSendRows").fate);
  assert.equal(countMeta("templatesOrphaned").fate, "orphaned");
  assert.equal(countMeta("subscriptions").fate, "destroyed");
});

test("GUARD — the manifest parses under either subject key and never loses the confirmation target", () => {
  // Two routes describe two different subjects; one dialog renders both, and
  // the typed confirmation compares against `target.label`. An empty label
  // would leave the confirmation comparing against "" — see §5.
  const fromRun = parseManifest(
    { run: { id: "run1", label: "Autumn 2026", courseTitle: "AISF", status: "running" } },
    "fallback",
  );
  assert.equal(fromRun.target.label, "Autumn 2026");
  assert.equal(fromRun.target.context, "AISF");

  const fromCourse = parseManifest(
    { course: { id: "c1", title: "AI Safety Fundamentals", status: "published" } },
    "fallback",
  );
  assert.equal(fromCourse.target.label, "AI Safety Fundamentals");
  assert.equal(fromCourse.target.context, null);

  assert.equal(parseManifest({}, "Autumn 2026").target.label, "Autumn 2026");
  assert.notEqual(parseManifest({ run: {} }, "Autumn 2026").target.label, "");

  // The run manifest's subject really is `run` with a `label`, and the course
  // manifest's is `course` with a `title` — the two spellings the parser
  // accepts. If a route renames its subject the dialog falls back to the
  // caller's label and the confirmation still works, which is why this is a
  // pin and not a crash.
  assert.match(RUN_MANIFEST, /run:\s*\{[\s\S]{0,200}?label: run\.label/);
  assert.match(COURSE_MANIFEST, /course:\s*\{[\s\S]{0,200}?title: course\.title/);
});

test("GUARD — blockers survive parsing as human sentences; junk in the array does not", () => {
  const parsed = parseManifest(
    {
      run: { id: "run1", label: "Autumn 2026" },
      blockers: [
        "This run is running with 38 active enrolments — archive it first.",
        "",
        "   ",
        null,
        42,
        { message: "nope" },
      ],
    },
    "x",
  );
  assert.equal(parsed.blockers.length, 1);
  assert.match(parsed.blockers[0], /archive it first/);
});

// ===========================================================================
// §2 CASCADE STEP ORDER — leaf before index
//
// Not a stylistic preference. Two things make order load-bearing here:
// Firestore does NOT delete subcollections with their parent, and two stages
// are addressed through data that lives on the doomed document itself.
// ===========================================================================

const stageAt = (key) => {
  const i = STAGE_ORDER.indexOf(key);
  assert.notEqual(i, -1, `the cascade has no "${key}" stage — every row that names the run must go`);
  return i;
};

test("MODEL — the cascade's declared stage order is the one the contract needs", () => {
  assert.deepEqual(STAGE_ORDER, [
    "progress",
    "exerciseResponses",
    "attendanceRegisters",
    "enrolments",
    "applications",
    "mirroredTasks",
    "nudgeMarkers",
    "subscriptionRows",
    "groups",
    "weeks",
  ]);
  // Every stage is drained by the SAME loop, so the table above is the order —
  // there is no second sequence hidden in a straight-line function to drift
  // from it, and a stage added to the table is automatically budgeted, paged
  // and resumed like the rest.
  assert.match(ENGINE, /for \(const stage of stages\)/);
});

test("MODEL — leaf before index: every dependent stage precedes the one that names it", () => {
  // 1. The WRITE GATE. `firestore.rules` lets a member client-write
  //    courseProgress while their enrolment is active, so the enrolment is what
  //    keeps the leaf lane OPEN. The engine drains the leaves first and shuts
  //    the gate immediately after — the accountDeletion ordering lesson
  //    ("attendance before enrolments") in its second form.
  for (const leaf of ["progress", "exerciseResponses", "attendanceRegisters"]) {
    assert.ok(
      stageAt(leaf) < stageAt("enrolments"),
      `${leaf} is drained after the enrolments that gate its writes`,
    );
  }

  // 2. The STRUCTURAL CONTAINERS go after everything that referenced them.
  for (const container of ["groups", "weeks"]) {
    for (const dependent of [
      "progress",
      "exerciseResponses",
      "attendanceRegisters",
      "enrolments",
      "applications",
      "mirroredTasks",
      "subscriptionRows",
    ]) {
      assert.ok(
        stageAt(dependent) < stageAt(container),
        `${dependent} is drained after ${container}`,
      );
    }
  }
});

test("MODEL — the run document is deleted LAST, and its subcollection is drained before it", () => {
  // Firestore does NOT delete subcollections with their parent. `weeks` lives
  // under the run doc, so deleting the run first would strand every week
  // document at a path with no parent — invisible to the console tree, absent
  // from every query, and unreachable by any resume, because the resume marker
  // was on the doc that just vanished.
  assert.ok(STAGE_ORDER.includes("weeks"));
  const loopEnd = ENGINE.indexOf("finalBatch");
  const weeksAt = ENGINE.indexOf('key: "weeks"');
  assert.ok(weeksAt !== -1 && weeksAt < loopEnd, "weeks is no longer drained inside the loop");
  assert.match(ENGINE, /finalBatch\.delete\(runRef\)/);
  assert.ok(
    ENGINE.indexOf("finalBatch.delete(runRef)") > weeksAt,
    "the run doc is deleted before its weeks subcollection is drained",
  );

  // The cohort subscription rows are addressed by the channel, which is
  // DERIVED from the run id rather than read off the run document — see the
  // dedicated guard in §8. Everything else about the stage is unchanged: it
  // still has to run while the rest of the run's rows are findable.
  assert.equal(courseRunChannel("run1"), "cohort:run1");
  assert.equal(normalizeCourseRun("run1", {}).channel, courseRunChannel("run1"));
  assert.match(ENGINE, /drainSubscriptionRows\(db, courseRunChannel\(runId\)/);
  assert.ok(stageAt("subscriptionRows") < STAGE_ORDER.length);

  // Finalisation is ONE batch: the audit row's completedAt and the run delete
  // land together. There is no instant where the run is gone but the audit row
  // still reads "interrupted", or where it reads "finished" over a live run.
  const final = ENGINE.slice(loopEnd);
  assert.match(final, /completedAt: FieldValue\.serverTimestamp\(\)/);
  assert.ok(
    final.indexOf("completedAt") < final.indexOf("finalBatch.delete(runRef)"),
  );
});

test("GUARD — the cascade does NOT delete the collections the manifest calls survivors", () => {
  // The dialog tells the operator `emailSends` rows are KEPT and templates are
  // merely ORPHANED. If the engine deleted either, the manifest would be lying
  // at the exact moment it is trusted most. This is the only thing tying the
  // two halves together.
  for (const collection of ["emailSends", "courseTemplates"]) {
    const re = new RegExp(`collection\\("${collection}"\\)[\\s\\S]{0,400}?\\.delete\\(`);
    assert.doesNotMatch(
      ENGINE,
      re,
      `the cascade deletes "${collection}", but the manifest reports those rows as surviving`,
    );
  }
  assert.equal(countMeta("emailSendRows").fate, "retained");
  assert.equal(countMeta("templates").fate, "orphaned");
  // Both are still COUNTED — "how much history mentions this run" is worth
  // knowing even when nothing happens to it.
  assert.match(ENGINE, /collection\("emailSends"\)/);
});

test("MODEL — a course is destroyed run-by-run, and its own cascade never fans into run rows", () => {
  // "A course with any non-destroyed run is a blocker — runs are destroyed one
  // at a time, deliberately." So by the time the course cascade runs there is
  // nothing left to cascade INTO, and it must not grow a fan-out later: that
  // would collapse ten typed confirmations into one.
  const courseCascade = ENGINE.slice(ENGINE.indexOf("export async function destroyCourseCascade"));
  assert.ok(courseCascade.length > 0, "destroyCourseCascade is gone");
  for (const collection of [
    "courseProgress",
    "courseExerciseResponses",
    "courseApplications",
    "courseAttendance",
    "courseEnrolments",
    "courseGroups",
  ]) {
    assert.doesNotMatch(
      courseCascade,
      new RegExp(`collection\\("${collection}"\\)[\\s\\S]{0,300}?delete\\(`),
      `the course cascade deletes ${collection} directly instead of via its runs`,
    );
  }
  assert.match(courseCascade, /finalBatch\.delete\(courseRef\)/);
  // And the race re-check: a run created between the blocker check and the
  // marker landing must stop the delete, or its courseId is orphaned forever.
  assert.match(courseCascade, /lateRuns/);
  assert.match(courseCascade, /complete: false/);
});

// ===========================================================================
// §3 PAGE-BUDGET ARITHMETIC
//
// `complete: false` means "call me again, identically". Getting the boundary
// wrong in one direction reports a clean destroy over rows that are still
// there; in the other it loops forever. Both are silent.
// ===========================================================================

/**
 * The engine's drain, reproduced: one shared DOCUMENT budget spent across all
 * stages, delete-as-you-read paging inside each stage (no cursor — deleting the
 * page makes the next query's first page the next unprocessed page), and full
 * passes until a pass deletes nothing.
 *
 * Pinned to the engine by `MODEL — the engine's tuning constants` below.
 */
function invoke(rows, { pageSize, docBudget, maxPasses, stages }, recreatedPerPass = null) {
  const remaining = { ...rows };
  let budget = docBudget;
  const deleted = {};
  let passes = 0;

  for (let pass = 1; ; pass += 1) {
    if (pass > maxPasses) throw new Error("still producing rows after the pass ceiling");
    passes = pass;
    // A member racing the sweep (or a delete that is not taking effect) puts
    // rows back between passes — the only thing the pass ceiling exists for.
    if (recreatedPerPass && pass > 1) {
      for (const [k, n] of Object.entries(recreatedPerPass)) {
        remaining[k] = (remaining[k] ?? 0) + n;
      }
    }
    let passDeleted = 0;
    let allDrained = true;

    for (const stage of stages) {
      if (budget <= 0) {
        allDrained = false;
        break;
      }
      // drainQuery: page until empty, short, or out of budget.
      let stageDeleted = 0;
      let drained = false;
      while (budget > 0) {
        const limit = Math.min(pageSize, budget);
        const took = Math.min(remaining[stage] ?? 0, limit);
        if (took === 0) {
          drained = true;
          break;
        }
        remaining[stage] -= took;
        stageDeleted += took;
        budget -= took;
        if (took < limit) {
          drained = true;
          break;
        }
      }
      deleted[stage] = (deleted[stage] ?? 0) + stageDeleted;
      passDeleted += stageDeleted;
      if (!drained) allDrained = false;
    }

    if (!allDrained) return { deleted, complete: false, passes };
    if (passDeleted === 0) return { deleted, complete: true, passes };
  }
}

/** Repeat the identical call until it says complete — the resume contract. */
function destroyToCompletion(rows, cfg) {
  const left = { ...rows };
  const total = {};
  let invocations = 0;
  for (;;) {
    const res = invoke(left, cfg);
    invocations += 1;
    for (const [k, v] of Object.entries(res.deleted)) {
      left[k] -= v;
      total[k] = (total[k] ?? 0) + v;
    }
    if (res.complete) return { total, invocations };
    assert.ok(invocations < 1000, "the identical call never drains — resumability is broken");
  }
}

const CFG = { pageSize: 250, docBudget: 500, maxPasses: 5, stages: ["progress", "enrolments"] };

test("MODEL — the engine's tuning constants, and what each one is bounded by", () => {
  const pageSize = engineConst("DESTROY_PAGE_SIZE");
  const docBudget = engineConst("DESTROY_DOC_BUDGET");
  const taskPage = engineConst("TASK_PAGE_SIZE");
  const maxPasses = engineConst("MAX_PASSES");

  assert.equal(pageSize, CFG.pageSize, "the model below is calibrated to this value");
  assert.equal(docBudget, CFG.docBudget);
  assert.equal(maxPasses, CFG.maxPasses);

  // A Firestore batch commits at most 500 writes, and a page becomes one batch.
  assert.ok(pageSize > 0 && pageSize <= 500, `page size ${pageSize} is not batch-safe`);
  // A mirrored task costs a whole recursiveDelete (comments, activity,
  // attachments) on top of its own document, so its page must be far smaller
  // than a leaf-row page or one page becomes minutes.
  assert.ok(taskPage < pageSize / 4, `TASK_PAGE_SIZE ${taskPage} is not much smaller than a leaf page`);
  // The per-request budget has to fit a 60s Cloud Run request with room for the
  // audit write — bounded, not merely positive.
  assert.ok(docBudget >= pageSize, "a budget below one page can never fill a page");
  assert.ok(docBudget <= 20_000, `${docBudget} documents is too much for one request`);
  // The pass ceiling is a throw, not a stop: the drained-guard lesson.
  assert.ok(maxPasses >= 2, "a verify pass needs at least two passes");
  assert.match(ENGINE, /still producing rows after \$\{MAX_PASSES\} full passes/);
  assert.match(ENGINE, /did not shrink after a committed delete/);
});

test("GUARD — `complete` requires a verify pass that deleted nothing", () => {
  // The leaves are drained BEFORE the enrolment that gates their writes, so a
  // member racing the sweep can re-create a progress row after its stage
  // drained. The mandatory zero-delete pass is what closes that window: by the
  // time a pass finds every stage empty, the write gate has been shut since an
  // earlier pass. Remove the verify pass and this destroy silently keeps rows.
  const tiny = invoke({ progress: 10, enrolments: 2 }, CFG);
  assert.equal(tiny.complete, true);
  assert.ok(tiny.passes >= 2, "completed on the first pass — nothing verified the drain");

  // An empty run still completes, in one pass, having deleted nothing. The
  // resume loop must not read that as "did nothing and isn't finished".
  const empty = invoke({ progress: 0, enrolments: 0 }, CFG);
  assert.deepEqual(empty, { deleted: { progress: 0, enrolments: 0 }, complete: true, passes: 1 });
});

test("GUARD — page-budget boundaries: the cases that decide complete vs resume", () => {
  const { pageSize, docBudget } = CFG;

  // A short page is the drained signal.
  assert.equal(invoke({ progress: 1, enrolments: 0 }, CFG).complete, true);
  assert.equal(invoke({ progress: pageSize - 1, enrolments: 0 }, CFG).complete, true);

  // EXACTLY one full page: the page was full, so the stage cannot know it is
  // drained and spends another (empty) page finding out. Still one invocation,
  // because the budget is two pages wide.
  const onePage = invoke({ progress: pageSize, enrolments: 0 }, CFG);
  assert.equal(onePage.complete, true);
  assert.equal(onePage.deleted.progress, pageSize);

  // EXACTLY the budget: every document allowed was spent, so the invocation
  // must return `complete: false` even though nothing is left. Reporting `true`
  // here would be a guess, and it is the dangerous direction.
  const exact = invoke({ progress: docBudget, enrolments: 0 }, CFG);
  assert.equal(exact.complete, false);
  assert.equal(exact.deleted.progress, docBudget);
  // The repeat call finds it empty and completes. Two invocations, zero loss.
  assert.deepEqual(destroyToCompletion({ progress: docBudget, enrolments: 0 }, CFG), {
    total: { progress: docBudget, enrolments: 0 },
    invocations: 2,
  });

  // The budget is SHARED across stages, so a stage that spends it all starves
  // the ones after it — and those must report un-drained rather than empty.
  const starved = invoke({ progress: docBudget, enrolments: 40 }, CFG);
  assert.equal(starved.complete, false);
  assert.equal(starved.deleted.enrolments ?? 0, 0, "a starved stage must not report a drain");
});

test("GUARD — identical repeated calls always drain, and every incomplete pass makes progress", () => {
  // The resume contract in one assertion: the SAME call, repeated, finishes —
  // and the number of calls scales with the budget, not with luck.
  for (const rows of [
    { progress: 0, enrolments: 0 },
    { progress: 1, enrolments: 1 },
    { progress: 499, enrolments: 1 },
    { progress: 5_000, enrolments: 400 },
    { progress: 50_000, enrolments: 4_000 },
  ]) {
    const { total, invocations } = destroyToCompletion(rows, CFG);
    assert.deepEqual(total, rows, "the cascade did not delete exactly what was there");
    const work = rows.progress + rows.enrolments;
    assert.equal(
      invocations,
      Math.floor(work / CFG.docBudget) + 1,
      `${work} rows took the wrong number of invocations`,
    );
  }

  // `useDestroy` gives up after two consecutive passes that remove nothing
  // while reporting more to do. That guard is only safe if a healthy cascade
  // never has such a pass — otherwise it abandons working destroys.
  const left = { progress: 50_000, enrolments: 4_000 };
  for (;;) {
    const res = invoke(left, CFG);
    const moved = sumCounts(res.deleted);
    if (res.complete) break;
    assert.ok(moved > 0, "an incomplete invocation removed nothing — the idle guard would fire");
    for (const [k, v] of Object.entries(res.deleted)) left[k] -= v;
  }
  assert.match(HOOK, /MAX_IDLE_PASSES/);
});

test("GUARD — a pathological cascade THROWS rather than reporting a clean destroy", () => {
  // The P8 lesson: a delete that reports success without removing rows would
  // otherwise loop while "making progress" on paper, inflating the audit row
  // over data that is still there. Rows reappearing every pass must end the
  // invocation with an error, not with `complete`.
  // Ten progress rows put back between every pass: each pass deletes ten and
  // drains cleanly, so `allDrained` stays true and `passDeleted` never reaches
  // zero. Without a ceiling this spins forever while the audit row inflates.
  assert.throws(() => invoke({ progress: 10, enrolments: 0 }, CFG, { progress: 10 }), /pass ceiling/);
  // One recreation and then quiet still finishes — the ceiling is for a
  // pathology, not for an unlucky click.
  const recovered = invoke({ progress: 10, enrolments: 0 }, CFG);
  assert.equal(recovered.complete, true);
  // And the engine's own two guards, both fatal, both stated in its text.
  assert.match(ENGINE, /aborting rather than looping/);
  assert.match(ENGINE, /throw new Error\(\s*\n?\s*`courseDeletion: run \$\{runId\} still producing rows/);
});

// ===========================================================================
// §4 BLOCKER PREDICATES
//
// The sentences standing between an operator and a live cohort. They are
// rendered VERBATIM in the Danger-zone dialog, so each one is both the reason
// and the instruction.
// ===========================================================================

/** `runDestroyBlockers`, reproduced. Pinned to the engine below. */
function runBlockers({ status, activeEnrolments, applicationsOpenAt, applicationsCloseAt }, now) {
  const out = [];
  if (status === "running" && activeEnrolments > 0) {
    out.push(
      `This run is running with ${activeEnrolments} active enrolment${
        activeEnrolments === 1 ? "" : "s"
      } — mark the run completed or cancelled, or remove its active members, before destroying it.`,
    );
  }
  const opened = !applicationsOpenAt || now >= applicationsOpenAt;
  const notClosed = !applicationsCloseAt || now <= applicationsCloseAt;
  if (status === "applications-open" && opened && notClosed) {
    out.push(
      "Applications for this run are currently open — close applications before destroying it.",
    );
  }
  return out;
}

/** `courseDestroyBlockers`, reproduced (the run half). */
function courseBlockers(runs) {
  return runs.map(
    (r) => `Run "${r.label || r.id}" still exists — destroy runs one at a time first.`,
  );
}

const NOW = new Date("2026-11-01T12:00:00Z").getTime();

test("MODEL — the reproduced blockers are the engine's, word for word", () => {
  assert.match(
    ENGINE,
    /This run is running with \$\{active\} active enrolment\$\{active === 1 \? "" : "s"\} — mark the run completed or cancelled, or remove its active members, before destroying it\./,
  );
  assert.match(
    ENGINE,
    /Applications for this run are currently open — close applications before destroying it\./,
  );
  assert.match(ENGINE, /still exists — destroy runs one at a time first\./);
  // Blockers reach the client intact and become a 409, not a generic failure —
  // a refusal must be readable, because it is also the instruction.
  assert.match(ENGINE, /class DestroyBlockedError/);
  assert.match(RUN_DESTROY, /DestroyBlockedError[\s\S]{0,300}?status: 409/);
  assert.match(RUN_DESTROY, /blockers: err\.blockers/);
});

test("GUARD — only a genuinely live run blocks; the technicalities do not", () => {
  const base = { applicationsOpenAt: null, applicationsCloseAt: null };

  // Running, with members: blocked, and the number is the LIVE active count.
  const live = runBlockers({ ...base, status: "running", activeEnrolments: 38 }, NOW);
  assert.equal(live.length, 1);
  assert.match(live[0], /38 active enrolments/);
  // …and the instruction names an exit that actually clears it (see §4's
  // dead-end guard below).
  assert.match(live[0], /completed or cancelled/);

  // Running with nobody left on it: not blocked. A cohort that emptied out is
  // not a cohort, and forcing a ritual for it teaches people to ignore rituals.
  assert.deepEqual(runBlockers({ ...base, status: "running", activeEnrolments: 0 }, NOW), []);

  // Applications-open is blocked on its own, with or without applicants —
  // destroying a run the public can still apply to is a different failure.
  assert.equal(
    runBlockers({ ...base, status: "applications-open", activeEnrolments: 0 }, NOW).length,
    1,
  );

  // …but only while the WINDOW is genuinely open. A run whose close date has
  // passed is not accepting applications even if nobody moved the status, and
  // must not be blocked on a technicality (this mirrors the apply route's gate).
  assert.deepEqual(
    runBlockers(
      {
        status: "applications-open",
        activeEnrolments: 0,
        applicationsOpenAt: null,
        applicationsCloseAt: NOW - 1,
      },
      NOW,
    ),
    [],
  );
  // Nor before it opens.
  assert.deepEqual(
    runBlockers(
      {
        status: "applications-open",
        activeEnrolments: 0,
        applicationsOpenAt: NOW + 1,
        applicationsCloseAt: null,
      },
      NOW,
    ),
    [],
  );

  // Every settled status is destroyable with members still on the rows — which
  // is the point of the protocol: destroy is for finished cohorts.
  for (const status of ["draft", "applications-closed", "completed", "cancelled"]) {
    assert.deepEqual(runBlockers({ ...base, status, activeEnrolments: 38 }, NOW), []);
  }
});

test("GUARD — the blocker predicates are exhaustive over the run status union", () => {
  // If a status is added, this fails until someone decides whether a run in it
  // may be destroyed. That decision must not be made by falling through.
  const BLOCKING = new Set(["running", "applications-open"]);
  const SETTLED = new Set(["draft", "applications-closed", "completed", "cancelled"]);
  for (const status of COURSE_RUN_STATUSES) {
    assert.ok(
      BLOCKING.has(status) || SETTLED.has(status),
      `${status} is neither blocking nor settled — the predicate does not cover it`,
    );
  }
  assert.equal(BLOCKING.size + SETTLED.size, COURSE_RUN_STATUSES.length);
  // `archived` is orthogonal to status — the whole point of the v2 decision.
  // There is no "archived" member of the union to reach for.
  assert.equal(COURSE_RUN_STATUSES.includes("archived"), false);
  // Whitespace-tolerant: this is a prose claim in a comment that wraps where
  // the formatter puts it, and pinning the exact newline made a reflow read as
  // a broken invariant.
  assert.match(ENGINE, /the course status union HAS an[\s*]+archived member, unlike runs/);
});

test("GUARD — blockers are human sentences carrying the live number, not codes", () => {
  const samples = [
    ...runBlockers(
      { status: "running", activeEnrolments: 38, applicationsOpenAt: null, applicationsCloseAt: null },
      NOW,
    ),
    ...runBlockers(
      { status: "running", activeEnrolments: 1, applicationsOpenAt: null, applicationsCloseAt: null },
      NOW,
    ),
    ...runBlockers(
      { status: "applications-open", activeEnrolments: 0, applicationsOpenAt: null, applicationsCloseAt: null },
      NOW,
    ),
    ...courseBlockers([{ id: "run1", label: "Autumn 2026" }]),
  ];
  assert.equal(samples.length, 4);
  for (const s of samples) {
    assert.match(s, /^[A-Z]/, `not a sentence: ${s}`);
    assert.match(s, /\.$/, `no terminal punctuation: ${s}`);
    assert.doesNotMatch(s, /[a-z][A-Z]/, `carries an identifier: ${s}`);
    assert.doesNotMatch(s, /_|\{|\}|undefined|null|NaN/, `carries machine text: ${s}`);
    assert.match(s, / — /, `no instruction clause: ${s}`);
  }
  // Singular and plural, because "1 enrolments" is how a dialog stops being read.
  assert.match(samples[0], /38 active enrolments —/);
  assert.match(samples[1], /1 active enrolment —/);
  // And it no longer sends anyone down the archive dead end (see the guard
  // that replaced that PROVEN GAP, below).
  assert.doesNotMatch(samples[0], /archive it first/);
  // A run with no label still names itself, so a blocker is never `Run "" `.
  assert.match(courseBlockers([{ id: "run-abc", label: "" }])[0], /Run "run-abc"/);
});

test("GUARD — a course is blocked by EVERY surviving run, one sentence each", () => {
  // A count would send an admin spelunking; a sentence per run is the whole
  // path out, listed. Archiving a run does not remove it from this list —
  // archiving makes a course invisible, not empty.
  const three = courseBlockers([
    { id: "r1", label: "Autumn 2026" },
    { id: "r2", label: "Spring 2027" },
    { id: "r3", label: "Autumn 2027" },
  ]);
  assert.equal(three.length, 3);
  assert.deepEqual(courseBlockers([]), []);
  // Stray rows block too rather than being silently stranded: once the course
  // doc goes, a courseId-keyed orphan is permanently unfindable.
  assert.match(ENGINE, /Orphaned group rows still reference this course/);
  assert.match(ENGINE, /Orphaned enrolment rows still reference this course/);
});

test("GUARD — a RESUME never re-evaluates blockers", () => {
  // Half the data is already gone by then, and the decision was made once. A
  // re-blocked resume would wedge an interrupted cascade forever — e.g. a
  // "running" run whose status can no longer be moved because the admin UI has
  // already dropped it from every list.
  assert.match(ENGINE, /if \(!alreadyDestroying\) \{\s*\n\s*const blockers/);
  assert.match(ENGINE, /a resume never re-evaluates blockers/i);
  assert.equal((ENGINE.match(/if \(!alreadyDestroying\)/g) ?? []).length, 2, "both cascades");
});

// ===========================================================================
// §5 BYTE-EQUALITY OF confirmName
//
// The last gate, and only a gate if it is exact. Every "helpful" normalisation
// is a way to destroy the wrong thing: two runs of the same course differ by
// their label alone.
// ===========================================================================

/** The comparison, reproduced: `!==` on the raw strings, nothing else. */
function confirmNameMatches(typed, expected) {
  if (typeof typed !== "string" || typeof expected !== "string") return false;
  return typed === expected;
}

test("GUARD — confirmName is byte equality, and every convenience is refused", () => {
  const label = "Autumn 2026";
  assert.equal(confirmNameMatches("Autumn 2026", label), true);

  // Whitespace. The input box may trim; the COMPARISON does not.
  assert.equal(confirmNameMatches("Autumn 2026 ", label), false);
  assert.equal(confirmNameMatches(" Autumn 2026", label), false);
  assert.equal(confirmNameMatches("Autumn  2026", label), false);
  assert.equal(confirmNameMatches("Autumn 2026", label), false, "nbsp is not a space");

  // Case.
  assert.equal(confirmNameMatches("autumn 2026", label), false);
  assert.equal(confirmNameMatches("AUTUMN 2026", label), false);

  // Unicode. macOS produces decomposed forms from some input paths, so a label
  // with an accent can be typed to LOOK identical and differ byte for byte.
  // Byte equality means that fails, which is the correct, safe direction.
  const nfc = "Été 2026";
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd);
  assert.equal(confirmNameMatches(nfd, nfc), false);
  assert.equal(confirmNameMatches(nfc, nfc), true);

  // Invisible characters pasted out of a spreadsheet or a chat client.
  assert.equal(confirmNameMatches("Autumn​ 2026", label), false);

  // Neighbouring runs of the same course differ ONLY by label — this is what
  // the gate actually protects against.
  assert.equal(confirmNameMatches("Autumn 2026", "Autumn 2027"), false);
  assert.equal(confirmNameMatches("Spring 2026", "Autumn 2026"), false);

  // Non-strings from a hand-rolled request body.
  assert.equal(confirmNameMatches(undefined, label), false);
  assert.equal(confirmNameMatches(null, label), false);
  assert.equal(confirmNameMatches(["Autumn 2026"], label), false);
});

test("MODEL — the destroy routes compare the raw strings and normalise nothing", () => {
  for (const [source, name, field] of [
    [RUN_DESTROY, "run destroy", "run.label"],
    [COURSE_DESTROY, "course destroy", "course.title"],
  ]) {
    // The type check first: a non-string body field is a 400, not a comparison.
    assert.match(source, /typeof body\.confirmName !== "string"/, `${name} does not type-check the body`);
    assert.match(
      source,
      new RegExp(`body\\.confirmName !== ${field.replace(".", "\\.")}`),
      `${name} no longer compares confirmName against ${field} with !==`,
    );
    for (const forbidden of [
      /confirmName[^\n;]*\.trim\(\)/,
      /confirmName[^\n;]*\.toLowerCase\(\)/,
      /confirmName[^\n;]*\.toUpperCase\(\)/,
      /confirmName[^\n;]*\.normalize\(/,
      /confirmName[^\n;]*\.localeCompare\(/,
    ]) {
      assert.doesNotMatch(
        source,
        forbidden,
        `${name} normalises confirmName before comparing — the confirmation must be byte-exact`,
      );
    }
    // And the refusal happens BEFORE the cascade is entered.
    assert.ok(
      source.indexOf("confirmName !==") < source.search(/destroy(Run|Course)Cascade\(/),
      `${name} runs the cascade before checking the confirmation`,
    );
  }
  // The run confirms on the LABEL and the course on the TITLE — the pinned
  // contract, and the reason the dialog carries both spellings (§1).
  assert.doesNotMatch(RUN_DESTROY, /course\.title/);
  assert.doesNotMatch(COURSE_DESTROY, /run\.label/);
});

// ===========================================================================
// §6 THE AUDIT ROW — the only surviving evidence of a destroy
// ===========================================================================

test("MODEL — the audit row is opened before anything dies, in one transaction with the marker", () => {
  // Audit-first, the `impersonations` pattern. Two admins double-clicking
  // Destroy race to this point, and a batch pair would let BOTH create an audit
  // row — one dangling at completedAt: null forever, indistinguishable from a
  // real interrupted destroy. The transaction re-reads the marker so exactly
  // one caller creates the row and the loser resumes it.
  assert.match(ENGINE, /return db\.runTransaction\(async \(txn\) => \{/);
  // The seed + the resume increment, each carrying this pass's lease claim
  // (see the lease guard below) — hence the tolerant middles.
  assert.match(ENGINE, /txn\.create\(auditRef, \{ \.\.\.auditSeed, resumeCount: 0[\s\S]{0,60}?\}\)/);
  assert.match(
    ENGINE,
    /txn\.update\(auditRef, \{\s*\n?\s*resumeCount: FieldValue\.increment\(1\)/,
  );
  assert.match(ENGINE, /destroying: true,\s*\n\s*destroyAuditId: auditRef\.id/);

  // The marker lands in the SAME write as the audit row: there is no instant
  // where deletion has begun but no audit row exists, and none where an audit
  // row exists but the run still looks alive to every discovery surface.
  const begin = ENGINE.slice(ENGINE.indexOf("async function beginDestroy"));
  assert.ok(begin.indexOf("txn.create(auditRef") < begin.indexOf("txn.update(targetRef"));

  // beginDestroy precedes the drain in both cascades.
  for (const fn of ["destroyRunCascade", "destroyCourseCascade"]) {
    const body = ENGINE.slice(ENGINE.indexOf(`export async function ${fn}`));
    const audit = body.indexOf("beginDestroy(");
    const firstDelete = body.search(/finalBatch\.delete|stage\.drain\(\)/);
    assert.notEqual(audit, -1, `${fn} does not open an audit row`);
    assert.ok(audit < firstDelete, `${fn} deletes before the audit row exists`);
  }

  // The accumulating fields, and the one that closes the record.
  assert.match(ENGINE, /patch\[`deleted\.\$\{key\}`\] = FieldValue\.increment\(n\)/);
  assert.match(ENGINE, /resumeCount/);
  assert.match(ENGINE, /completedAt: null/);
  // The audit collection name is exported once and used everywhere, so the
  // rules block and the engine cannot drift onto two different collections.
  assert.match(ENGINE, /export const COURSE_DELETIONS_COLLECTION = "courseDeletions"/);
});

test("MODEL — the audit row is PII-light: a display name, never an email", () => {
  // The row outlives everything it describes, so it must not become the last
  // place a destroyed cohort's admin email survives.
  assert.match(ENGINE, /Display name, never an email/);
  assert.match(RUN_DESTROY, /actor\.displayName\?\.trim\(\) \|\| "NAISI admin"/);
  assert.doesNotMatch(RUN_DESTROY, /actorEmail|actor\.email/);
  assert.doesNotMatch(COURSE_DESTROY, /actorEmail|actor\.email/);
});

// ===========================================================================
// §7 THE SHAPE OF THE SURFACES
// ===========================================================================

test("MODEL — the engine is server-only and silent", () => {
  assert.match(ENGINE, /^import "server-only";/m, "the engine is missing the server-only guard");
  // A destroy sends nothing. There is no "your course was deleted" email, and
  // an accidental one would go to a cohort whose data has just been erased.
  assert.doesNotMatch(ENGINE, /from "@?\/?.*lib\/email\/send"|sendEmail\(/);
  assert.doesNotMatch(ENGINE, /NEXT_PUBLIC_/);
  // Admin SDK, which is what makes `allow write: if false` on courseDeletions a
  // complete lockout rather than an inconvenience.
  assert.match(ENGINE, /firebase-admin\/firestore/);
  // Storage cleanup is best-effort: an orphaned blob beats a phantom document,
  // and a Storage blip must never wedge a cascade mid-flight.
  assert.match(ENGINE, /best-effort/);
});

test("MODEL — every new route authorises BEFORE it looks anything up, and awaits its params", () => {
  // House rule, and it matters most here: an existence check that ran first
  // would turn each route into an oracle for which run and course ids exist.
  for (const [source, name] of ROUTES) {
    const auth = source.search(/getCurrentUser\(/);
    const lookup = source.search(/\.get\(\)/);
    assert.notEqual(auth, -1, `${name} does not authenticate`);
    assert.notEqual(lookup, -1, `${name} does not read its target`);
    assert.ok(auth < lookup, `${name} reads a document before authorising`);
    // Next 16: route params are Promises.
    assert.match(source, /await ctx\.params/, `${name} does not await its params`);
  }
});

test("MODEL — destroy is admin-only; archive is the wider, reversible lane", () => {
  for (const [source, name] of [
    [RUN_DESTROY, "run destroy"],
    [COURSE_DESTROY, "course destroy"],
    [RUN_MANIFEST, "run manifest"],
    [COURSE_MANIFEST, "course manifest"],
  ]) {
    assert.match(source, /actor\.role !== "admin"/, `${name} is not admin-gated`);
    // Not approveCourse: the cascade deletes MEMBER work — progress, answers,
    // attendance — which is above the content permission by locked decision.
    assert.doesNotMatch(source, /permissions\.approveCourse/, `${name} admits approveCourse`);
  }

  // Archive is the everyday soft path, so it takes the status route's bar.
  assert.match(RUN_ARCHIVE, /export async function PATCH/, "archive is not a PATCH");
  assert.match(RUN_ARCHIVE, /actor\.role === "admin" \|\| actor\.permissions\.approveCourse/);
  assert.match(RUN_ARCHIVE, /typeof body\.archived !== "boolean"/);
  // It writes the flag and the stamp and nothing else — it is not a second run
  // editor, and `status` stays on its own route because archive is orthogonal.
  assert.match(RUN_ARCHIVE, /ref\.update\(\{\s*\n\s*archived: body\.archived,\s*\n\s*updatedAt:/);
  assert.doesNotMatch(
    RUN_ARCHIVE,
    /\bstatus:\s*"(draft|applications-open|applications-closed|running|completed|cancelled)"/,
    "the archive route also moves the run's status",
  );
  // And it refuses to touch a run mid-destroy: un-archiving one would put it
  // back on the discovery surfaces while its rows are being deleted underneath.
  assert.match(RUN_ARCHIVE, /raw\.destroying === true/);
  assert.match(RUN_ARCHIVE, /status: 409/);
  // Idempotent, so a double-click is a no-op rather than an error.
  assert.match(RUN_ARCHIVE, /\(raw\.archived === true\) === body\.archived/);
});

// ===========================================================================
// §8 THE CLOSED GAPS
//
// Three PROVEN GAPs used to live here, each asserting a disagreement between
// two halves of this feature was still present. All three are closed, and the
// assertions are INVERTED in place — the same tests, now holding the fix down
// — so the history of what was decided stays attached to what enforces it.
// ===========================================================================

test('GUARD — the running-cohort blocker names an exit that WORKS, not "archive it first"', () => {
  // The gap: the blocker fires on `status === "running"` with active
  // enrolments and used to say "archive it first". `archived` is ORTHOGONAL to
  // status (the whole v2 decision), so archiving left `status: "running"`
  // untouched and the identical blocker came straight back — an instruction
  // that could be followed to the letter and change nothing.
  //
  // RESOLVED by the owner in favour of keeping the gate and fixing the words:
  // making archive sufficient would have made an archived-but-running cohort
  // with live members destroyable in one step, which is exactly the state the
  // blocker exists for. So the predicate is unchanged and the sentence now
  // names the two things that actually clear it.
  assert.match(ENGINE, /if \(run\.status === "running"\) \{/);
  const blockers = ENGINE.slice(
    ENGINE.indexOf("export async function runDestroyBlockers"),
    ENGINE.indexOf("// The run cascade"),
  );
  assert.ok(blockers.length > 0);
  // The gate still does NOT consult `archived` — that is the decision, not an
  // oversight: archiving is not a step towards destroying.
  assert.doesNotMatch(blockers, /run\.archived/);
  assert.doesNotMatch(
    blockers,
    /archive it first/,
    "the dead-end instruction is back — archiving cannot clear a status-based blocker",
  );
  assert.match(blockers, /mark the run completed or cancelled, or remove its active members/);
  // Both exits named, and both are real: `completed` and `cancelled` are the
  // status route's terminal moves from `running`, and removing enrolments is
  // what takes the count to zero.
  const sentence = runBlockers(
    {
      status: "running",
      activeEnrolments: 38,
      applicationsOpenAt: null,
      applicationsCloseAt: null,
    },
    NOW,
  )[0];
  for (const exit of ["completed", "cancelled", "remove its active members"]) {
    assert.ok(sentence.includes(exit), `the blocker does not name the ${exit} exit`);
  }
});

test("GUARD — the route reports the ACCUMULATED totals, and the client trusts them", () => {
  // The gap: `DestroyCascadeResult.deleted` was THIS invocation's page while
  // `useDestroy` merged responses with per-key `Math.max` and rendered them as
  // running totals. A destroy that removed 500 rows and then 250 showed 500,
  // and the receipt's shortfall caveat then told the operator the manifest had
  // counted more than the cascade removed — a false alarm about a clean
  // destroy, printed by the one screen that has to be exact.
  //
  // FIXED ON THE SERVER, which is the only half that can be right: the audit
  // row already accumulates through FieldValue.increment, so the cascade reads
  // it back after its own increments land and returns that. The client does no
  // arithmetic at all — summing there would double-count a retried request.
  assert.match(ENGINE, /The ACCUMULATED totals for this destroy/);
  assert.match(ENGINE, /async function readAuditTotals\(/);
  // Both exits of the run cascade report the read-back, not the local map.
  assert.equal(
    (ENGINE.match(/deleted: await readAuditTotals\(auditRef/g) ?? []).length,
    4,
    "a cascade exit still reports its own pass instead of the audit totals",
  );
  assert.match(RUN_DESTROY, /deleted: result\.deleted/);
  // The client replaces rather than merges, and says so.
  assert.doesNotMatch(
    HOOK,
    /Math\.max\(out\[key\] \?\? 0, value\)/,
    "the hook is merging again — the response IS the running total",
  );
  assert.doesNotMatch(HOOK, /function mergeCounts/);
  assert.match(HOOK, /The response IS the running total/);
  assert.match(HOOK, /deletedRef\.current = incoming/);

  // The arithmetic that was wrong, now stated the right way round: two passes
  // of a destroy report accumulated totals, so the last response IS the truth.
  const responses = [{ progress: 500 }, { progress: 750, enrolments: 38 }];
  let held = {};
  for (const r of responses) held = r;
  assert.equal(sumCounts(held), 788, "what actually died");

  // And the idle guard survives the change: a pass that removes nothing now
  // repeats the previous total rather than reporting zero, so the hook
  // compares totals instead of testing the response for emptiness.
  assert.match(HOOK, /sumCounts\(incoming\) <= before/);
});

test("GUARD — both manifests report an interrupted destroy, so a crashed cascade is visible", () => {
  // The gap: the client was fully built to surface one — `interrupted` in the
  // manifest type, `toInterrupted` parsing it, `estimatedTotal` folding it
  // into the denominator, the beforeunload guard documented as "a nudge, not a
  // safety net" BECAUSE the manifest would surface it on the next visit — and
  // neither manifest route read `courseDeletions` at all. A cascade that died
  // mid-page left the run marked, dropped from every discovery surface, and
  // discoverable only in the Firestore console.
  assert.match(HOOK, /interrupted: InterruptedDestroy \| null/);
  // (The claim is wrapped across two comment lines in the hook, hence the
  // tolerant whitespace class rather than a literal sentence.)
  assert.match(HOOK, /which the[\s*]+manifest surfaces on the next visit/);

  // The engine exposes the read, and it is a document GET through the target's
  // own marker — no `completedAt == null` query, so no composite index.
  assert.match(ENGINE, /export async function readInterruptedDestroy\(/);
  assert.match(ENGINE, /export function readDestroyMarker\(/);
  assert.doesNotMatch(
    ENGINE.slice(ENGINE.indexOf("export async function readInterruptedDestroy")),
    /where\("targetId"/,
    "the interrupted read became a query — the marker names the row directly",
  );

  for (const [source, name] of [
    [RUN_MANIFEST, "run manifest"],
    [COURSE_MANIFEST, "course manifest"],
  ]) {
    assert.match(source, /readInterruptedDestroy\(db, raw\)/, `${name} does not read it`);
    assert.match(source, /interrupted,?\s*$/m, `${name} does not return it`);
    // A RESUME is never re-blocked: the engine skips its blockers for a marked
    // target, so a manifest that kept reporting them would withhold a Resume
    // the server would have honoured. Both routes ask the same question.
    assert.match(
      source,
      /readDestroyMarker\(raw\)\.destroying\s*\n?\s*\? Promise\.resolve<string\[\]>\(\[\]\)/,
      `${name} re-blocks a resume`,
    );
    // And the cheap read exists, so a page visit does not pay for ten
    // aggregation queries to answer one question (see §9).
    assert.match(source, /probe=|"probe"/, `${name} has no interrupted-only probe`);
  }

  // The client keys the banner and the resume off the parsed report.
  assert.match(HOOK, /loadInterrupted/);
  const parsed = parseManifest(
    {
      run: { id: "run1", label: "Autumn 2026" },
      interrupted: {
        auditId: "del1",
        startedAt: "2026-08-22T10:00:00.000Z",
        startedByName: "Admin One",
        deleted: { progress: 500, enrolments: 38 },
      },
    },
    "x",
  );
  assert.equal(parsed.interrupted?.auditId, "del1");
  assert.equal(sumCounts(parsed.interrupted.deleted), 538);
  // An interrupted report with no audit id names nothing and can resume
  // nothing, so it is not a report (the parser's own rule).
  assert.equal(parseManifest({ interrupted: { startedAt: "x" } }, "x").interrupted, null);
});

// ===========================================================================
// §9 THE SECOND REVIEW'S FINDINGS
//
// Everything below pins a fix from the review pass that followed the build.
// ===========================================================================

test("GUARD — the mirrored-task sweep is filtered on `source`, not just the pointer", () => {
  // `sourceRef` is a map subfield on `tasks`, and before firestore.rules
  // pinned it a committee member could stamp `sourceRef.cohortId = <a doomed
  // run>` onto an ordinary committee task. The cascade recursiveDeletes what
  // that sweep returns — comments, activity, attachments, Storage blobs — so
  // an unfiltered sweep aimed the admin's own destroy at anything a committee
  // member chose. The source filter is the half that also protects rows
  // written before the rules pin.
  assert.match(ENGINE, /const MIRRORED_TASK_SOURCE = "fellowship-reminder"/);
  const drain = ENGINE.slice(
    ENGINE.indexOf("async function drainMirroredTasks"),
    ENGINE.indexOf("async function drainSubscriptionRows"),
  );
  assert.ok(drain.length > 0, "drainMirroredTasks is gone");
  assert.match(drain, /\.where\("source", "==", MIRRORED_TASK_SOURCE\)/);
  assert.match(drain, /\.where\("sourceRef\.cohortId", "==", runId\)/);
  assert.ok(
    drain.indexOf('where("source"') < drain.indexOf('where("sourceRef.cohortId"'),
    "the sweep no longer leads with the source filter",
  );
  // The manifest counts the SAME rows — a manifest that counted forged
  // pointers would promise to destroy rows the cascade rightly leaves alone.
  const counts = ENGINE.slice(
    ENGINE.indexOf("export async function countRunDestroyTargets"),
    ENGINE.indexOf("export async function runDestroyBlockers"),
  );
  assert.match(counts, /\.where\("source", "==", MIRRORED_TASK_SOURCE\)/);
});

test("GUARD — the cohort channel is COMPUTED, never read off the run document", () => {
  // `drainSubscriptionRows` deletes every subscription row on the channel it
  // is given. Trusting `run.channel` meant a run doc carrying
  // `channel: "newsletter"` — a console edit, a bad migration — would turn one
  // run's destroy into a mass-unsubscribe of the whole site, rows gone before
  // anyone read the receipt. Deriving it from the run id makes that
  // unreachable rather than unlikely, and costs nothing: every other consumer
  // of the cohort channel already derives it the same way.
  assert.match(ENGINE, /drainSubscriptionRows\(db, courseRunChannel\(runId\)/);
  assert.match(ENGINE, /where\("channel", "==", courseRunChannel\(runId\)\)/);
  assert.doesNotMatch(
    ENGINE_CODE,
    /run\.channel/,
    "the cascade is trusting the run document's stored channel again",
  );
  assert.equal(courseRunChannel("run1"), "cohort:run1");
});

test("GUARD — an unnamed target is refused OUTRIGHT, before the confirmation compares", () => {
  // A run with an empty label reduces the typed confirmation to "" === "",
  // i.e. a ritual that passes by sending an empty body. Both routes refuse the
  // state instead, name the fix, and do it BEFORE the comparison.
  for (const [source, name, refusal, comparison] of [
    [RUN_DESTROY, "run destroy", /This run has no label/, "confirmName !== run.label"],
    [
      COURSE_DESTROY,
      "course destroy",
      /This course has no title/,
      "confirmName !== course.title",
    ],
  ]) {
    assert.match(source, refusal, `${name} accepts an unnamed target`);
    assert.match(source, /\.length === 0/, `${name} does not test for emptiness`);
    assert.ok(
      source.search(/\.length === 0/) < source.indexOf(comparison),
      `${name} checks the name after comparing it`,
    );
    assert.ok(
      source.indexOf("status: 409") < source.indexOf(comparison),
      `${name} does not refuse the empty case with a 409`,
    );
  }
  // The dialog says the same thing locally, so the button is never offered.
  assert.match(RUN_ZONE, /This run has no label/);
  assert.match(COURSE_ZONE, /This course has no title/);
});

test("GUARD — one destroy pass at a time: the audit row is leased inside the marker transaction", () => {
  // Two overlapping invocations would both increment the same audit row over
  // the same pages, and the accumulated totals this feature now reports would
  // stop being exact. The claim is taken in the SAME transaction that finds or
  // opens the row (so it cannot race the thing it protects) and released on
  // every exit.
  assert.match(ENGINE, /const PASS_LEASE_MS = 3 \* 60 \* 1000/);
  assert.match(ENGINE, /class DestroyPassInFlightError/);
  assert.match(ENGINE, /function assertPassLeaseFree\(/);
  assert.match(ENGINE, /passInFlightUntil: leaseUntil/);
  assert.match(ENGINE, /const PASS_LEASE_RELEASED = \{ passInFlightUntil: null \}/);
  // Claimed inside the transaction, not after it.
  const begin = ENGINE.slice(
    ENGINE.indexOf("async function beginDestroy"),
    ENGINE.indexOf("function assertPassLeaseFree"),
  );
  assert.match(begin, /return db\.runTransaction/);
  assert.ok(begin.indexOf("assertPassLeaseFree(") < begin.indexOf("txn.update(auditRef"));
  // Released on the incomplete exit, on the finalising batch, and on a throw.
  assert.ok(
    (ENGINE.match(/PASS_LEASE_RELEASED/g) ?? []).length >= 6,
    "an exit from a pass no longer hands the lease back",
  );
  assert.match(ENGINE, /await auditRef\.update\(PASS_LEASE_RELEASED\)\.catch\(\(\) => \{\}\)/);
  // Both destroy routes turn it into a 409 with the sentence intact — it is
  // contention, not failure, so the dialog offers Resume rather than an error.
  for (const [source, name] of [
    [RUN_DESTROY, "run destroy"],
    [COURSE_DESTROY, "course destroy"],
  ]) {
    assert.match(
      source,
      /err instanceof DestroyPassInFlightError[\s\S]{0,300}?status: 409/,
      `${name} does not answer a lease conflict with 409`,
    );
  }
  // The crash window is documented rather than pretended away.
  assert.match(ENGINE, /crash window|process that DIES mid-pass/i);
});

test("GUARD — `archived` is READ by every surface the danger-zone copy names", () => {
  // The archive half of the protocol is a boolean that is worth exactly as
  // much as the number of surfaces that consult it. The Danger zone promises
  // four: the admin list's default view, the public catalogue, members' live
  // sections on /learn, and the application window. Each one is pinned here,
  // because a promise made in copy and kept nowhere is how a run "archived"
  // before a destroy stays visible right up until its rows disappear.
  assert.match(RUN_ZONE, /out of the\s*\n?\s*public catalogue/);

  // 1. The public catalogue + the apply page's run lookup + the showcase.
  assert.match(FETCHERS, /if \(run\.archived\) continue;/);
  assert.equal(
    (FETCHERS.match(/if \(run\.archived\) continue;/g) ?? []).length,
    2,
    "one of the two public run lookups no longer skips archived runs",
  );
  assert.match(FETCHERS, /showcaseRun\.status === "draft" \|\| showcaseRun\.archived/);

  // 2. The application window — the POST refuses, not just the page.
  assert.match(RUN_APPLY, /if \(run\.archived\) \{/);
  assert.ok(
    RUN_APPLY.indexOf("if (run.archived) {") <
      RUN_APPLY.indexOf('run.status !== "applications-open"'),
    "the archived check runs after the status check, so an archived open run applies",
  );

  // 3. Members' live sections: the payload carries the flag, the dashboard
  //    drops those rows, the hub buckets them instead of mixing them in.
  assert.match(ME_ROUTE, /archived: run\.archived/);
  assert.match(ME_ROUTE, /archived: boolean/);
  assert.match(DASHBOARD_SUMMARY, /!entry\.archived/);
  assert.match(LEARN_HUB, /runs\.filter\(\(entry\) => !entry\.archived\)/);
  assert.match(LEARN_HUB, /runs\.filter\(\(entry\) => entry\.archived\)/);

  // 4. The admin list default, with a way back to the archived ones — a soft
  //    archive nobody can see is one nobody can undo.
  assert.match(ADMIN_RUNS_HOOK, /Number\(a\.archived\) - Number\(b\.archived\)/);
  assert.match(COURSE_EDITOR, /showArchivedRuns/);
  assert.match(COURSE_EDITOR, /Show archived \(\$\{archivedRunCount\}\)/);
  assert.match(COURSE_EDITOR, /runs\.items\.filter\(\(r: CourseRunDoc\) => !r\.archived\)/);

  // The type carries it, so none of the above is reading through a cast.
  assert.equal(normalizeCourseRun("run1", {}).archived, false);
  assert.equal(normalizeCourseRun("run1", { archived: true }).archived, true);
  assert.doesNotMatch(
    RUN_ZONE,
    /as unknown as \{ archived/,
    "the danger zone is reading `archived` through a cast again",
  );
});

test("GUARD — a run mid-DESTROY fails closed on the learning space and on its status", () => {
  // `archived` (set in the cascade's opening write) takes the run off the
  // DISCOVERY surfaces, but discovery is not access: anyone holding the URL
  // still walks in, and what they walk into is a cohort being emptied one page
  // at a time. The gate every /learn/[runId] surface passes through refuses a
  // destroying run outright — fused with "no such run", like every other null
  // it returns.
  assert.match(RUN_ACCESS, /if \(runRaw\.destroying === true\) return null;/);
  // Archived alone is NOT refused — that is the difference between the two
  // paths, and the promise archive makes to members.
  assert.doesNotMatch(RUN_ACCESS, /run\.archived.*return null/);

  // And the status route refuses to move a destroying run, the same 409 the
  // archive route gives: an approveCourse holder could otherwise flip a
  // half-destroyed cohort back to `running` mid-cascade.
  assert.match(RUN_STATUS, /data\.destroying === true/);
  assert.match(RUN_STATUS, /status: 409/);
  assert.ok(
    RUN_STATUS.indexOf("data.destroying === true") < RUN_STATUS.indexOf("ALLOWED_TRANSITIONS["),
    "the destroying check runs after the transition table",
  );
});

test("GUARD — the ten-query manifest waits for the disclosure; only the cheap probe is paid on mount", () => {
  // Every visit to a run or course editor used to pay a full manifest —
  // ~10 aggregation count queries — for a control nobody had touched. The
  // interrupted question still has to be asked on arrival (it is the one thing
  // a visitor who came for something else needs to be told), so it moved to a
  // two-document probe and the counts moved behind the disclosure.
  for (const [source, name] of [
    [RUN_ZONE, "run danger zone"],
    [COURSE_ZONE, "course danger zone"],
  ]) {
    assert.match(source, /void loadInterrupted\(\);/, `${name} does not probe on mount`);
    assert.doesNotMatch(
      source,
      /useEffect\(\(\) => \{\s*\n\s*void loadManifest\(\);/,
      `${name} still reads the whole manifest on mount`,
    );
    assert.match(
      source,
      /DangerDisclosure title="Danger zone" onFirstOpen=\{loadManifest\}/,
      `${name} does not load the manifest when the disclosure opens`,
    );
  }
  // Once, not on every toggle.
  assert.match(RUN_ZONE, /if \(!opened\.current\) \{/);
  assert.match(HOOK, /probe=interrupted/);
});

test("GUARD — the resume loop stops POSTing after unmount, and the copy says what is guaranteed", () => {
  // The loop can run for many round trips, and every state setter in it is
  // unmount-guarded — but the POSTs were not, so a closed dialog kept firing
  // passes at the route with nobody watching the result.
  const loop = HOOK.slice(HOOK.indexOf("for (let pass = 0; pass < MAX_PASSES"));
  assert.match(loop, /if \(!alive\.current\) return;/);
  assert.ok(
    loop.indexOf("if (!alive.current) return;") < loop.indexOf("await fetch(urls.destroy"),
    "the unmount check runs after the request it is supposed to prevent",
  );
  // The progress copy told the operator to leave the tab open as though that
  // were the safety property. What is actually guaranteed is that stopping
  // loses nothing and the page offers to resume.
  assert.doesNotMatch(RUN_ZONE, /Leave this tab open/);
  assert.match(RUN_ZONE, /Leaving this page stops it between passes/);
  assert.match(RUN_ZONE, /offer to resume/);
});
