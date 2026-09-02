/**
 * The round console's two pure predicates, plus source pins on the parts of
 * the routes that cannot be executed without a database.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why these two predicates get real tests
 *
 *  1. **`planStatusChange`** is the WHOLE status machine.
 *     `admissionRounds` is `allow write: if false`, so the transition table has
 *     no counterpart in `firestore.rules` and the route is the only thing
 *     standing between a round and a state nobody asked for. The lesson it is
 *     written against is `courseRuns`, where a `canApproveCourse()` holder can
 *     walk a live run backwards to draft because the server's table is the only
 *     copy and rules do not know about it. Every illegal move is enumerated
 *     here rather than spot-checked, because "closed cannot go back to draft"
 *     is exactly the kind of arrow a refactor quietly adds.
 *  2. **`roundReadiness`** is what stands between an unfinished round and a
 *     real applicant. It is rendered by the panel AND enforced by the status
 *     route, so the test that matters is that a check failing is a check the
 *     route will refuse on, not merely a tick that goes grey.
 *
 * ## Why the loader dance
 *
 * Same root cause as `admissions-predicates.test.mjs`: this repo's Node
 * predates the v22.18 that strips TypeScript natively, so the module graph is
 * transpiled in memory with the `typescript` devDependency.
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
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const { planStatusChange, nextStatuses } = await loadTs("lib/admissions/roundStatus.ts");
const { roundReadiness, readinessRefusal } = await loadTs("lib/admissions/readiness.ts");

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

// ---------------------------------------------------------------------------
// 1. The transition table
// ---------------------------------------------------------------------------

const STATUSES = ["draft", "open", "closed", "deciding", "settled", "cancelled"];

/** The table as the contract states it, written out INDEPENDENTLY of the
 *  module so the test is a second opinion rather than a mirror. */
const LEGAL = {
  draft: ["open", "cancelled"],
  open: ["closed", "cancelled"],
  closed: ["deciding", "open"],
  deciding: ["settled"],
  settled: [],
  cancelled: [],
};

test("every legal move is allowed, and reopening is the only one that must be confirmed", () => {
  for (const from of STATUSES) {
    for (const to of LEGAL[from]) {
      const plan = planStatusChange(from, to);
      assert.equal(plan.ok, true, `${from} -> ${to} should be legal`);
      assert.equal(plan.kind, "move");
      const reopening = from === "closed" && to === "open";
      assert.equal(
        plan.requiresConfirmation,
        reopening,
        `${from} -> ${to}: only closed -> open reopens a form people were told was shut`,
      );
      if (reopening) {
        assert.match(plan.confirmPrompt, /extending the window/);
      } else {
        assert.equal(plan.confirmPrompt, null);
      }
    }
  }
});

test("every illegal move is refused, with a sentence naming what is possible", () => {
  let refused = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to || LEGAL[from].includes(to)) continue;
      const plan = planStatusChange(from, to);
      refused += 1;
      assert.equal(plan.ok, false, `${from} -> ${to} must be refused`);
      assert.ok(
        plan.code === "terminal" || plan.code === "illegal",
        `${from} -> ${to} should be refused as terminal or illegal, got ${plan.code}`,
      );
      assert.ok(plan.error.length > 20, `${from} -> ${to} needs a real sentence`);
    }
  }
  // 6 x 6 grid, minus 6 same-status cells, minus the 7 legal arrows.
  assert.equal(refused, 23, "the whole grid is covered, not a sample of it");
});

test("the moves that would undo a decision are named explicitly", () => {
  // Spot-checks written as sentences, because a count above proves coverage
  // and these prove the RIGHT cells are in it.
  assert.equal(planStatusChange("open", "draft").ok, false);
  assert.equal(planStatusChange("closed", "draft").ok, false);
  assert.equal(planStatusChange("settled", "open").ok, false);
  assert.equal(planStatusChange("cancelled", "draft").ok, false);
  assert.equal(planStatusChange("cancelled", "open").ok, false);
  assert.equal(planStatusChange("deciding", "open").ok, false);
  assert.equal(planStatusChange("draft", "settled").ok, false);
  assert.equal(planStatusChange("settled", "cancelled").code, "terminal");
});

test("the same status is a no-op rather than an error", () => {
  for (const status of STATUSES) {
    const plan = planStatusChange(status, status);
    assert.equal(plan.ok, true, `${status} -> ${status} must not 400`);
    assert.equal(
      plan.kind,
      "noop",
      "a double-tapped control must not stamp an updatedAt claiming something moved",
    );
  }
});

test("a status the site does not recognise is reported, never repaired", () => {
  // A round whose stored status is junk must not be treated as a draft: a
  // machine that repairs its own input can move a live round somewhere nobody
  // asked for.
  assert.equal(planStatusChange("archived", "open").code, "unknown-status");
  assert.equal(planStatusChange(undefined, "open").code, "unknown-status");
  assert.equal(planStatusChange("draft", "published").code, "unknown-status");
  assert.equal(planStatusChange("draft", null).code, "unknown-status");
});

test("nextStatuses is the same table the route enforces", () => {
  for (const from of STATUSES) {
    assert.deepEqual(nextStatuses(from), LEGAL[from]);
  }
});

// ---------------------------------------------------------------------------
// 2. Readiness
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-10T12:00:00Z");

function readyRound(overrides = {}) {
  return {
    kind: "enrolment",
    status: "draft",
    closesAt: new Date("2026-10-18T22:59:00Z"),
    decisionsByDate: "2026-10-23",
    outcomeRunIds: ["run-incubator"],
    reviewerUids: ["reviewer-1"],
    finalDeciderUid: "admin-1",
    stages: [{ id: "s1", order: 0, questionCount: 4 }],
    ...overrides,
  };
}

test("a fully authored enrolment round is ready", () => {
  const readiness = roundReadiness(readyRound(), NOW);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.unmet.length, 0);
  assert.equal(readiness.checks.length, 6);
});

test("each missing piece is named on its own, with the section that fixes it", () => {
  const cases = [
    ["stage-questions", { stages: [{ id: "s1", order: 0, questionCount: 0 }] }, "stages"],
    ["stage-questions", { stages: [] }, "stages"],
    ["closes-at", { closesAt: null }, "window"],
    ["decisions-by", { decisionsByDate: null }, "window"],
    ["outcome-runs", { outcomeRunIds: [] }, "outcomes"],
    ["reviewers", { reviewerUids: [] }, "roles"],
    ["final-decider", { finalDeciderUid: null }, "roles"],
  ];
  for (const [id, overrides, section] of cases) {
    const readiness = roundReadiness(readyRound(overrides), NOW);
    assert.equal(readiness.ready, false, `${id} should block opening`);
    assert.deepEqual(
      readiness.unmet.map((c) => c.id),
      [id],
      `${id} should be the only blocker for ${JSON.stringify(overrides)}`,
    );
    assert.equal(readiness.unmet[0].section, section);
    assert.ok(readiness.unmet[0].hint.length > 20, "a blocker needs an actionable hint");
  }
});

test("a deadline in the past blocks opening, because the window would already be over", () => {
  const readiness = roundReadiness(
    readyRound({ closesAt: new Date("2026-09-01T22:59:00Z") }),
    NOW,
  );
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.unmet.map((c) => c.id), ["closes-at"]);
  assert.match(readiness.unmet[0].hint, /already passed/);
});

test("the first stage is the one that must carry questions, whatever order it was written in", () => {
  // `order` is the position in `round.stageIds`, and the array can arrive in
  // any order from a route that read a subcollection.
  const readiness = roundReadiness(
    readyRound({
      stages: [
        { id: "s2", order: 1, questionCount: 6 },
        { id: "s1", order: 0, questionCount: 0 },
      ],
    }),
    NOW,
  );
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.unmet.map((c) => c.id), ["stage-questions"]);
});

test("an appointment round needs no outcome run, and the check is dropped rather than ticked", () => {
  const readiness = roundReadiness(
    readyRound({ kind: "appointment", outcomeRunIds: [] }),
    NOW,
  );
  assert.equal(readiness.ready, true);
  assert.equal(
    readiness.checks.some((c) => c.id === "outcome-runs"),
    false,
    "a tick nobody earned is worse than no line at all: the facilitator round " +
      "appoints people to a job and places nobody on a run.",
  );
});

test("the refusal sentence lists every blocker, not just the first", () => {
  const readiness = roundReadiness(
    readyRound({ reviewerUids: [], finalDeciderUid: null, decisionsByDate: null }),
    NOW,
  );
  const refusal = readinessRefusal(readiness.unmet);
  assert.match(refusal, /not ready to open/);
  for (const check of readiness.unmet) assert.ok(refusal.includes(check.hint));
});

// ---------------------------------------------------------------------------
// 3. Route source pins
//
// These cannot run without a database, so they pin the SHAPE of the handler:
// each one is a decision that a refactor could undo silently and that no other
// test in the repo would notice.
// ---------------------------------------------------------------------------

const STATUS_ROUTE = "src/app/api/admissions/rounds/[roundId]/status/route.ts";
const STAGE_ROUTE = "src/app/api/admissions/rounds/[roundId]/stages/[stageId]/route.ts";
const RELEASE_ROUTE =
  "src/app/api/admissions/rounds/[roundId]/stages/[stageId]/release/route.ts";
const ROUND_ROUTE = "src/app/api/admissions/rounds/[roundId]/route.ts";
const ROLES_ROUTE = "src/app/api/admissions/rounds/[roundId]/roles/route.ts";

test("the status route holds ONE table and enforces readiness on the way open", () => {
  const src = source(STATUS_ROUTE);
  assert.match(
    src,
    /planStatusChange\(round\.status, body\.status\)/,
    "the route must ask the shared planner rather than carrying its own arrows.",
  );
  assert.ok(
    !/draft.*->.*open/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "no second copy of the arrows outside the comment block.",
  );
  assert.match(
    src,
    /roundReadiness\(/,
    "opening must be gated on the same predicate the panel renders, or the " +
      "panel eventually shows a tick beside a refusal.",
  );
  assert.match(
    src,
    /needsConfirmation: true/,
    "closed -> open must ask for an explicit confirmation.",
  );
});

test("the stage route range-checks limits AFTER sanitising, and names the question", () => {
  const src = source(STAGE_ROUTE);
  assert.match(
    src,
    /sanitizeSignupForm\(body\.questions, \{ clampLimits: false \}\)/,
    "clampLimits must be false on the way in, or an authored 5000 silently " +
      "becomes 4000 and the author is never told.",
  );
  const sanitiseAt = src.indexOf("sanitizeSignupForm");
  const validateAt = src.indexOf("validateQuestionLimits(");
  assert.ok(sanitiseAt > 0 && validateAt > sanitiseAt, "validate the sanitised form.");
  assert.match(
    src,
    /questionId: limitError\.questionId/,
    "the 400 has to name the question: sanitizeSignupForm is a filter, so a " +
      "check inside isValidQuestion would delete the question instead.",
  );
  assert.match(
    src,
    /status: 400/,
    "an out-of-range limit is the author's mistake to fix, so it is a 400.",
  );
  assert.match(
    src,
    /isValidDateKey\(rawRelease\)/,
    "a release date must round-trip, or 2026-02-31 releases with the round.",
  );
  assert.match(
    src,
    /cannot close after the round/,
    "a stage deadline past the round's is a date nobody can meet.",
  );
});

test("a stage releases only on an explicit POST", () => {
  const src = source(RELEASE_ROUTE);
  assert.match(src, /export async function POST\(/);
  assert.ok(
    !/export\s+(async\s+)?function\s+GET\(/.test(src),
    "no GET may stamp manualReleasedAt: a preview or a prefetch would then " +
      "publish an intake's questions, and a served question cannot be unserved.",
  );
  assert.match(
    src,
    /manualReleasedAt: FieldValue\.serverTimestamp\(\)/,
    "the release instant is the server's clock, not the browser's.",
  );
  assert.match(
    src,
    /alreadyReleased: true/,
    "pressing it twice reports the release it already made rather than moving " +
      "the timestamp.",
  );
});

test("the round PATCH refuses fields that belong to another route", () => {
  const src = source(ROUND_ROUTE);
  for (const field of ["status", "reviewerUids", "finalDeciderUid", "applicationCounts"]) {
    assert.ok(
      src.includes(`"${field}"`),
      `${field} must be listed as foreign: a console that thinks it saved it ` +
        "and a server that silently dropped it is the failure that surfaces on " +
        "decision day.",
    );
  }
  assert.match(src, /needsForce: true/, "the freeze asks for an explicit force.");
  assert.match(
    src,
    /submitted > 0 && body\.force !== true/,
    "the freeze is keyed on submitted applications, not on the round's status.",
  );
});

test("the roles route is admin only and moves the nav flag both ways", () => {
  const src = source(ROLES_ROUTE);
  assert.match(
    src,
    /user\.role !== "admin"/,
    "appointing a reviewer is an access grant, not authoring: approveCourse is " +
      "not enough.",
  );
  assert.match(src, /isEligibleAdmissionsReviewer\(candidate\)/);
  assert.match(src, /admissionsReviewer: true/);
  assert.match(
    src,
    /admissionsReviewer: false/,
    "a removed reviewer must lose the flag, or the Admissions entry outlives " +
      "the appointment.",
  );
  assert.match(
    src,
    /array-contains/,
    "somebody removed from one round keeps the flag while another round still " +
      "names them.",
  );
});

test("admissionsReviewer rides the auth snapshot rather than a per-navigation query", () => {
  const provider = source("src/auth/AuthProvider.tsx");
  assert.match(
    provider,
    /setAdmissionsReviewer\(Boolean\(data\?\.admissionsReviewer\)\)/,
    "the flag comes off the user-doc listener the provider already holds.",
  );
  const session = source("src/lib/firebase/session.ts");
  assert.match(session, /admissionsReviewer: Boolean\(data\.admissionsReviewer\)/);
  const shell = source("src/layout/AppShell.tsx");
  assert.match(
    shell,
    /v\.role === "admin" \|\| v\.admissionsReviewer/,
    "the Admissions nav group is gated on the snapshot flag, never on an " +
      "admissionRounds query in the layout.",
  );
  assert.ok(
    !/admissionRounds/.test(source("src/app/(app)/layout.tsx")),
    "(app)/layout.tsx must not learn to query rounds: that is the cost this " +
      "denormalisation exists to avoid.",
  );
});
