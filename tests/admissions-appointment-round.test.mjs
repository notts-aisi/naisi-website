/**
 * The APPOINTMENT round: the facilitator intake, and the ways it is a
 * different object from the autumn enrolment round rather than the same one
 * with different words on it.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth pinning here
 *
 *  1. **The readiness matrix, for BOTH kinds.** Readiness is what stands
 *     between an unfinished round and a real applicant, and the two kinds are
 *     held to different lists. A matrix rather than a spot check, because the
 *     failure that costs the facilitator round its window is a check silently
 *     appearing (an outcome target nobody can supply, blocking the Open button
 *     on 21 September) or silently disappearing (a reviewer list nobody
 *     appointed, discovered when the queue is empty on 4 October).
 *  2. **The route refusals.** `admissionRounds` is `allow read, write: if
 *     false`, so the PATCH route is the only writer and its refusals are the
 *     whole of the rule. They are pinned against the source, because the
 *     handler cannot be executed without an Admin SDK.
 *  3. **That the appointment branch of the apply form mounts NO programme
 *     preference.** The gate is the round's KIND, not the section's `enabled`
 *     flag, so a round misauthored past the route's refusal still cannot ask a
 *     volunteer which programme they would like a place on.
 *
 * ## Why the loader dance
 *
 * Same root cause as `admissions-round-console.test.mjs`: this repo's Node
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

const { roundReadiness, READINESS_KIND_NOTE } = await loadTs("lib/admissions/readiness.ts");
const { applyCopy } = await loadTs("lib/admissions/applyCopy.ts");
const { readProgrammePreference } = await loadTs("lib/admissions/applyRoutes.ts");

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

// ---------------------------------------------------------------------------
// 1. The readiness matrix
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-10T12:00:00Z");

/**
 * The bar each kind is held to, written out INDEPENDENTLY of the module so
 * this is a second opinion rather than a mirror of it. Order matters: it is
 * the order the panel renders.
 */
const EXPECTED_CHECKS = {
  enrolment: [
    "stage-questions",
    "closes-at",
    "decisions-by",
    "outcome-runs",
    "reviewers",
    "final-decider",
  ],
  appointment: [
    "stage-questions",
    "closes-at",
    "decisions-by",
    "reviewers",
    "final-decider",
  ],
};

function readyRound(kind, overrides = {}) {
  return {
    kind,
    status: "draft",
    closesAt: new Date("2026-10-04T22:59:00Z"),
    decisionsByDate: "2026-10-05",
    // An appointment round legitimately has none, and an enrolment round
    // cannot open without one: the same field, two different bars.
    outcomeRunIds: kind === "enrolment" ? ["run-incubator"] : [],
    reviewerUids: ["reviewer-1"],
    finalDeciderUid: "admin-1",
    stages: [{ id: "s1", order: 0, questionCount: 3 }],
    ...overrides,
  };
}

test("each kind is held to exactly its own list of checks, in the rendered order", () => {
  for (const kind of ["enrolment", "appointment"]) {
    const readiness = roundReadiness(readyRound(kind), NOW);
    assert.deepEqual(
      readiness.checks.map((c) => c.id),
      EXPECTED_CHECKS[kind],
      `the ${kind} bar has drifted`,
    );
    assert.equal(readiness.ready, true, `a fully authored ${kind} round is ready`);
    assert.equal(readiness.unmet.length, 0);
  }
});

test("an appointment round never shows an outcome-run line, met or unmet", () => {
  // Both the empty case (the real one) and the case where somebody managed to
  // store an outcome run on the wrong kind. Neither may put a line on the
  // panel: a tick nobody earned reads as a thing that was checked.
  for (const outcomeRunIds of [[], ["run-stray"]]) {
    const readiness = roundReadiness(readyRound("appointment", { outcomeRunIds }), NOW);
    assert.equal(
      readiness.checks.some((c) => c.id === "outcome-runs"),
      false,
    );
    assert.equal(readiness.ready, true);
  }
});

test("an enrolment round with no outcome run is refused, and it is the only blocker", () => {
  const readiness = roundReadiness(readyRound("enrolment", { outcomeRunIds: [] }), NOW);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.unmet.map((c) => c.id), ["outcome-runs"]);
  assert.equal(readiness.unmet[0].section, "outcomes");
});

test("the checks both kinds share block both kinds, one blocker at a time", () => {
  // The point of the matrix: dropping the outcome check for an appointment
  // round must not have dropped the people and the dates with it. The
  // facilitator round closes on 4 October and is decided that evening, so a
  // round opened with no reviewer and no decider has nobody to decide it.
  const shared = [
    ["stage-questions", { stages: [{ id: "s1", order: 0, questionCount: 0 }] }, "stages"],
    ["closes-at", { closesAt: null }, "window"],
    ["decisions-by", { decisionsByDate: null }, "window"],
    ["reviewers", { reviewerUids: [] }, "roles"],
    ["final-decider", { finalDeciderUid: null }, "roles"],
  ];
  for (const kind of ["enrolment", "appointment"]) {
    for (const [id, overrides, section] of shared) {
      const readiness = roundReadiness(readyRound(kind, overrides), NOW);
      assert.equal(readiness.ready, false, `${kind}: ${id} should block opening`);
      assert.deepEqual(
        readiness.unmet.map((c) => c.id),
        [id],
        `${kind}: ${id} should be the only blocker`,
      );
      assert.equal(readiness.unmet[0].section, section);
    }
  }
});

test("every kind has a panel note, and the appointment one says what is missing and why", () => {
  for (const kind of ["enrolment", "appointment"]) {
    assert.ok(
      READINESS_KIND_NOTE[kind] && READINESS_KIND_NOTE[kind].length > 40,
      `${kind} needs a sentence explaining its bar`,
    );
  }
  assert.match(READINESS_KIND_NOTE.appointment, /no outcome run/i);
});

test("the panel renders the note for the kind it was handed", () => {
  const panel = source("src/features/admissions/ReadinessPanel.tsx");
  assert.match(panel, /READINESS_KIND_NOTE\[round\.kind\]/);
});

// ---------------------------------------------------------------------------
// 2. The route refusals
// ---------------------------------------------------------------------------

const roundPatch = source("src/app/api/admissions/rounds/[roundId]/route.ts");

test("the round PATCH refuses an outcome run on an appointment round", () => {
  const clause = roundPatch.slice(roundPatch.indexOf('if ("outcomeRunIds" in body)'));
  assert.match(
    clause.slice(0, 700),
    /current\.kind === "appointment" && outcomeRunIds\.length > 0/,
    "the outcome refusal has to read the STORED kind, not one off the wire",
  );
  assert.match(clause.slice(0, 900), /does not place people on a course run/);
});

test("the round PATCH refuses a programme preference on an appointment round", () => {
  const start = roundPatch.indexOf('if ("programmePreference" in body)');
  assert.ok(start > 0, "the programme branch is gone");
  const clause = roundPatch.slice(start, start + 900);
  assert.match(clause, /current\.kind === "appointment"/);
  assert.match(
    clause,
    /bad\("An appointment round does not ask applicants to choose a programme\."\)/,
  );
  // The refusal must come BEFORE the value is read, or a malformed body would
  // answer with a shape complaint about a section this round cannot have.
  assert.ok(
    clause.indexOf('current.kind === "appointment"')
      < clause.indexOf("readProgrammePreference(body.programmePreference)"),
  );
});

test("a round's kind is refused on the way in rather than dropped", () => {
  assert.match(roundPatch, /const IMMUTABLE_FIELDS = \["kind"\]/);
  const guard = roundPatch.slice(roundPatch.indexOf("const immutable ="));
  assert.match(guard.slice(0, 500), /status: 400/);
  assert.match(guard.slice(0, 500), /fixed when it is created/);
  // Ahead of the foreign-field check and everything that writes: a body naming
  // the kind is refused whatever else it carries.
  assert.ok(
    roundPatch.indexOf("const immutable =") < roundPatch.indexOf("const foreign ="),
  );
});

test("the apply read path drops a programme answer on an appointment round", () => {
  const round = {
    kind: "appointment",
    // Enabled and populated, i.e. a round that somehow got past the refusal
    // above. The answer is still dropped, on the kind.
    programmePreference: {
      enabled: true,
      streams: [{ id: "technical", label: "Technical" }],
      fellowships: [{ id: "run-a", label: "Governance fellowship" }],
      maxRankedFellowships: 2,
      offerFellowshipFallback: true,
    },
  };
  const answer = readProgrammePreference(
    { streamId: "technical", rankedFellowshipIds: ["run-a"], openToFellowship: true },
    round,
  );
  assert.deepEqual(answer, {
    streamId: null,
    rankedFellowshipIds: [],
    openToFellowship: false,
  });

  // The same payload against the same section as an ENROLMENT round: proof the
  // drop is the kind and not a broken reader.
  const kept = readProgrammePreference(
    { streamId: "technical", rankedFellowshipIds: ["run-a"], openToFellowship: true },
    { ...round, kind: "enrolment" },
  );
  assert.deepEqual(kept, {
    streamId: "technical",
    rankedFellowshipIds: ["run-a"],
    openToFellowship: true,
  });
});

// ---------------------------------------------------------------------------
// 3. The apply surfaces
// ---------------------------------------------------------------------------

test("the appointment branch of the apply form mounts no programme preference", () => {
  const flow = source("src/features/admissions/ApplyFlow.tsx");

  // ONE mount, and it is inside the guard.
  const mounts = flow.match(/<ProgrammePreference\b/g) ?? [];
  assert.equal(mounts.length, 1, "there is exactly one place this can be rendered");

  assert.match(
    flow,
    /const asksProgramme =\s*round\.kind !== "appointment" && round\.programmePreference\.enabled/,
    "the gate has to carry the kind, not just the section's own flag",
  );

  const guardOpen = flow.indexOf("{asksProgramme ? (");
  assert.ok(guardOpen > 0, "the section is no longer rendered behind asksProgramme");
  const guardClose = flow.indexOf(") : null}", guardOpen);
  const mountAt = flow.indexOf("<ProgrammePreference");
  assert.ok(
    guardOpen < mountAt && mountAt < guardClose,
    "the only mount must sit inside the kind-aware guard",
  );

  // And nothing else may gate on the section's own flag: a second reader of
  // `programmePreference.enabled` is how the kind check gets bypassed later.
  const bareFlagUses = flow.match(/round\.programmePreference\.enabled/g) ?? [];
  assert.equal(bareFlagUses.length, 1, "the flag is read once, inside the kind gate");
});

test("the console gives an appointment round no programme editor either", () => {
  const editor = source("src/features/admissions/RoundEditor.tsx");
  assert.match(
    editor,
    /round\.kind === "enrolment" \? \(\s*<ProgrammeSection/,
    "the editable programme section is enrolment-only",
  );
  assert.match(editor, /<AppointmentProgrammeNote \/>/);
  // The outcomes save must not send a field the route refuses on this kind.
  assert.match(
    editor,
    /patch\(appointment \? \{ evidenceRunIds \} : \{ outcomeRunIds, evidenceRunIds \}\)/,
  );
});

test("the applicant projection carries the kind, or none of the above can branch", () => {
  const routes = source("src/lib/admissions/applyRoutes.ts");
  const start = routes.indexOf("export function serialiseRoundForApplicant");
  const projection = routes.slice(start, routes.indexOf("};", start));
  assert.match(projection, /kind: round\.kind/);

  const types = source("src/lib/admissions/applyTypes.ts");
  assert.match(types, /kind: AdmissionRoundDoc\["kind"\]/);
});

test("an appointment round is called an application to facilitate, on every surface", () => {
  const enrolment = applyCopy("enrolment");
  const appointment = applyCopy("appointment");

  // Two keys are deliberately not a pair. `standfirst` is the one line the
  // enrolment round does not have at all, and `startAction` is the same words
  // for both on purpose: the card heading directly above it already names the
  // form, so a button repeating "to facilitate" is noise on a phone.
  const SAME_ON_PURPOSE = ["standfirst", "startAction"];
  for (const key of Object.keys(enrolment)) {
    if (SAME_ON_PURPOSE.includes(key)) continue;
    assert.ok(appointment[key], `the appointment copy is missing ${key}`);
    assert.notEqual(
      appointment[key],
      enrolment[key],
      `${key} says the same thing for both kinds, so the facilitator round reads as an intake`,
    );
  }

  assert.equal(enrolment.standfirst, "");
  assert.equal(appointment.startAction, enrolment.startAction);
  assert.match(appointment.standfirst, /facilitate/i);
  assert.match(appointment.submitAction, /facilitate/i);
  assert.match(appointment.signInTitle, /facilitate/i);

  // An unrecognised kind falls back to the generic wording rather than a blank
  // heading: `normalizeAdmissionRound` already coerces the stored field, so
  // this only ever sees a payload from another deploy.
  assert.deepEqual(applyCopy("something-else"), enrolment);
});

test("both apply surfaces take their wording from the one table", () => {
  const page = source("src/app/(public)/apply/[roundId]/page.tsx");
  assert.match(page, /import \{ applyCopy \} from "@\/lib\/admissions\/applyCopy"/);
  assert.match(page, /const copy = applyCopy\(round\.kind\)/);
  assert.match(page, /\{copy\.standfirst \? \(/);

  const flow = source("src/features/admissions/ApplyFlow.tsx");
  assert.match(flow, /const copy = applyCopy\(round\.kind\)/);
  for (const key of ["startTitle", "startAction", "submitAction", "submittedTitle"]) {
    assert.match(flow, new RegExp(`copy\\.${key}`), `ApplyFlow ignores copy.${key}`);
  }
});

test("a facilitator applicant is any signed-in account that has not been refused", () => {
  // Pending is the load-bearing case: somebody who made an account at the fair
  // on the Monday is still pending when the facilitator window closes on the
  // Sunday, and the round exists to recruit exactly those people.
  const context = source("src/lib/admissions/applyContext.ts");
  const gate = context.slice(context.indexOf("export async function requireApplicant"));
  assert.match(gate.slice(0, 800), /user\.role === "rejected"/);
  assert.equal(
    /role === "pending"/.test(gate.slice(0, 800)),
    false,
    "a pending account must not be turned away from the apply routes",
  );

  const page = source("src/app/(public)/apply/[roundId]/page.tsx");
  assert.match(page, /user\.role === "rejected" \?/);
  assert.match(page, /pendingNote=\{user\.role === "pending"\}/);
});
