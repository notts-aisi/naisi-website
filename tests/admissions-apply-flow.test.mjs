/**
 * The applicant apply flow: the release boundary, the payload readers, the
 * availability codec's round trip, and source pins on the parts of the routes
 * that cannot run without a database.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing rather than reading
 *
 *  1. **`serialiseStageForApplicant`** IS the timed-release guarantee.
 *     `admissionRounds/{roundId}/stages/{stageId}` is `allow read, write: if
 *     false`, so the only path from a stored question to a browser runs
 *     through this function. The test asserts the unreleased arm has no
 *     `questions` key AT ALL, rather than an empty one: an applicant with
 *     devtools open must not be able to read week three's essay question in
 *     week one, and "the field is there but empty" is one refactor away from
 *     "the field is there".
 *  2. **The payload readers** decide what an applicant can put on a row nobody
 *     can read back through rules. The geometry pin on `readAvailability` is
 *     the sharpest of them: a client that could name its own grid could store
 *     a mask whose bit 0 means 06:00 while every reader believes it means
 *     09:00, and the failure surfaces as somebody being put in a session they
 *     said they could not make.
 *  3. **The availability round trip** goes through the wire format. Seven hex
 *     strings are what the decide route reads to build seat-row labels, so a
 *     bug in the codec does not look like a broken screen.
 *  4. **The counter arithmetic** is read OUT OF THE ROUTE SOURCE and replayed
 *     against a model, so the test is a second opinion on the increments the
 *     handlers actually contain rather than a copy of them.
 *
 * ## Why the loader dance
 *
 * Same root cause as `admissions-round-console.test.mjs`: this repo's Node
 * predates the v22.18 that strips TypeScript natively, so the module graph is
 * transpiled in memory with the `typescript` devDependency. That also means
 * these tests can only import plain `.ts`, which is why the availability
 * state model lives outside the `.tsx` component that draws it.
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
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const apply = await loadTs("lib/admissions/applyRoutes.ts");
const availability = await loadTs("lib/admissions/availability.ts");
const model = await loadTs("features/admissions/availabilityModel.ts");
const authReturn = await loadTs("lib/authReturn.ts");

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

const APPLY_ROUTE = "src/app/api/admissions/rounds/[roundId]/apply/route.ts";
const SUBMIT_ROUTE = "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts";
const STAGE_ROUTE = "src/app/api/admissions/rounds/[roundId]/apply/stage/[stageId]/route.ts";
const STAGES_ROUTE = "src/app/api/admissions/rounds/[roundId]/stages/route.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRID = { version: 1, startMinute: 9 * 60, endMinute: 18 * 60, slotMinutes: 15 };

function makeRound(overrides = {}) {
  return {
    id: "autumn-2026__abc",
    kind: "enrolment",
    label: "Autumn 2026 intake",
    slug: "autumn-2026",
    blurb: "Two programmes, one form.",
    academicYear: "2026/27",
    status: "open",
    opensAt: new Date("2026-09-21T08:00:00Z"),
    closesAt: new Date("2026-10-18T22:59:00Z"),
    decisionsByDate: "2026-10-23",
    stageIds: ["s1", "s2"],
    programmePreference: {
      enabled: true,
      streams: [
        { id: "technical", label: "Technical" },
        { id: "governance", label: "Governance" },
      ],
      fellowships: [
        { id: "run-tech", label: "Technical fellowship" },
        { id: "run-gov", label: "Governance fellowship" },
        { id: "run-agi", label: "AGI strategy fellowship" },
      ],
      maxRankedFellowships: 2,
      offerFellowshipFallback: true,
    },
    availabilityGrid: { ...GRID },
    accessRequirementsPrompt: "Anything we should know?",
    criteria: [{ id: "c1", label: "Motivation", guidance: "Look for specifics" }],
    scoreScale: { min: 1, max: 5 },
    reviewersPerApplication: 2,
    reviewerUids: ["reviewer-1", "reviewer-2"],
    finalDeciderUid: "decider-1",
    blind: { hideNames: true, hideMembership: true },
    evidenceRunIds: ["run-precourse"],
    reminderOffsets: [],
    outcomeRunIds: ["run-incubator"],
    applicationCounts: {
      draft: 4,
      submitted: 11,
      accepted: 0,
      "fellowship-offered": 0,
      waitlisted: 0,
      rejected: 0,
      withdrawn: 1,
    },
    archived: false,
    clonedFromRoundId: null,
    authorUid: "author-1",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeStage(overrides = {}) {
  return {
    id: "s1",
    roundId: "autumn-2026__abc",
    label: "Stage 1",
    intro: "Tell us about yourself.",
    questions: [
      { id: "q1", type: "longText", label: "Why this?", required: true, maxLength: 800 },
      { id: "q2", type: "shortText", label: "Your course", required: false },
    ],
    releaseAt: null,
    releaseTimeLocal: "09:00",
    manualReleasedAt: null,
    closesAt: null,
    locksOnSubmit: true,
    order: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const DURING_WINDOW = new Date("2026-10-01T12:00:00Z");

// ---------------------------------------------------------------------------
// 1. The release boundary
// ---------------------------------------------------------------------------

describe("the release boundary", () => {
  const round = makeRound();

  test("an unreleased stage is served with NO questions key at all", () => {
    const stage = makeStage({ id: "s2", order: 1, releaseAt: "2026-11-06" });
    const wire = apply.serialiseStageForApplicant(stage, round, DURING_WINDOW);

    assert.equal(wire.released, false);
    // Not `questions: []`, not `questions: undefined`. The key must not exist,
    // because "the field is there but empty" is one refactor from "the field
    // is there".
    assert.equal(
      Object.prototype.hasOwnProperty.call(wire, "questions"),
      false,
      "an unreleased stage carried a questions key",
    );
    // The COUNT would leak how much work the unseen stage is, and the intro is
    // authored prose about the questions.
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "questionCount"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "intro"), false);
    // What it does carry: enough to render "Stage 2 opens ...".
    assert.deepEqual(Object.keys(wire).sort(), [
      "id",
      "label",
      "order",
      "released",
      "releasesAt",
    ]);
    assert.equal(typeof wire.releasesAt, "string");
  });

  test("a serialised unreleased stage carries no question text anywhere in its JSON", () => {
    const stage = makeStage({
      id: "s2",
      order: 1,
      releaseAt: "2026-11-06",
      questions: [
        { id: "secret", type: "longText", label: "Recreate a paper", required: true },
      ],
    });
    const json = JSON.stringify(
      apply.serialiseStageForApplicant(stage, round, DURING_WINDOW),
    );
    assert.equal(json.includes("Recreate a paper"), false);
    assert.equal(json.includes("secret"), false);
  });

  test("a released stage carries its questions", () => {
    const wire = apply.serialiseStageForApplicant(makeStage(), round, DURING_WINDOW);
    assert.equal(wire.released, true);
    assert.equal(wire.questions.length, 2);
    assert.equal(wire.questionCount, 2);
  });

  test("a stage of a round whose window has not opened is never released", () => {
    const early = new Date("2026-09-01T12:00:00Z");
    const wire = apply.serialiseStageForApplicant(makeStage(), round, early);
    assert.equal(wire.released, false);
  });

  test("a stage of a cancelled round is never released, whatever its date says", () => {
    const cancelled = makeRound({ status: "cancelled" });
    const wire = apply.serialiseStageForApplicant(makeStage(), cancelled, DURING_WINDOW);
    assert.equal(wire.released, false);
  });

  test("releasedStages returns only the released ones", () => {
    const stages = [
      makeStage(),
      makeStage({ id: "s2", order: 1, releaseAt: "2026-11-06" }),
    ];
    const open = apply.releasedStages(stages, round, DURING_WINDOW);
    assert.deepEqual(open.map((s) => s.id), ["s1"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Source pin: the filter precedes the serialisation
// ---------------------------------------------------------------------------

describe("the release filter runs before serialisation", () => {
  const src = source("src/lib/admissions/applyRoutes.ts");
  const fn = src.slice(
    src.indexOf("export function serialiseStageForApplicant("),
    src.indexOf("/** The released stages"),
  );

  test("the function body exists and was found", () => {
    assert.ok(fn.length > 100, "could not slice serialiseStageForApplicant out of the source");
  });

  test("isStageReleased is asked before serialiseStage is ever called", () => {
    const guard = fn.indexOf("isStageReleased(");
    const serialise = fn.indexOf("serialiseStage(");
    assert.ok(guard !== -1, "the release predicate is not called at all");
    assert.ok(serialise !== -1, "the stage serialiser is not called at all");
    assert.ok(
      guard < serialise,
      "serialiseStage is reached before isStageReleased: an unreleased stage would be built with its questions and then have them removed, which is a filter rather than a boundary",
    );
  });

  test("the unreleased branch RETURNS rather than falling through", () => {
    const guard = fn.indexOf("if (!isStageReleased(");
    const ret = fn.indexOf("return {", guard);
    const serialise = fn.indexOf("serialiseStage(");
    assert.ok(
      guard < ret && ret < serialise,
      "the unreleased branch does not return before the serialiser",
    );
  });

  test("the stages route serialises through that one function and no other", () => {
    const route = source(STAGES_ROUTE);
    assert.match(route, /serialiseStageForApplicant/);
    assert.equal(
      /\bserialiseStage\(/.test(route),
      false,
      "the applicant stages route calls the staff serialiser directly, which takes includeQuestions as an argument somebody can pass true",
    );
  });

  test("a draft or archived round is 404 on the applicant stages route", () => {
    const route = source(STAGES_ROUTE);
    assert.match(route, /round\.archived \|\| round\.status === "draft"/);
  });

  test("the stages route is signed-in only", () => {
    const route = source(STAGES_ROUTE);
    assert.match(route, /if \(!user\) return NextResponse\.json\(\{ error: "Not signed in\." \}/);
  });
});

// ---------------------------------------------------------------------------
// 3. Answers: the enforceRequired split
// ---------------------------------------------------------------------------

describe("stage answers", () => {
  const round = makeRound();
  const stages = [
    makeStage(),
    makeStage({ id: "s2", order: 1, releaseAt: "2026-11-06" }),
  ];

  test("a draft may leave a required question blank", () => {
    const out = apply.readStageAnswers(
      { s1: { q2: "Physics" } },
      stages,
      round,
      DURING_WINDOW,
      {},
      false,
    );
    assert.deepEqual(out, { s1: { q2: "Physics" } });
  });

  test("a submit refuses the same blank required question, and names it", () => {
    const out = apply.readStageAnswers(
      { s1: { q2: "Physics" } },
      stages,
      round,
      DURING_WINDOW,
      {},
      true,
    );
    assert.ok(apply.isFieldError(out));
    assert.equal(out.questionId, "q1");
    assert.equal(out.stageId, "s1");
    assert.match(out.error, /required/i);
  });

  test("a draft still refuses an answer over its own character limit", () => {
    const out = apply.readStageAnswers(
      { s1: { q1: "x".repeat(801) } },
      stages,
      round,
      DURING_WINDOW,
      {},
      false,
    );
    assert.ok(apply.isFieldError(out));
    assert.equal(out.questionId, "q1");
    assert.match(out.error, /too long/i);
  });

  test("answers for an UNRELEASED stage are refused, not silently dropped", () => {
    const out = apply.readStageAnswers(
      { s2: { q1: "an early answer" } },
      stages,
      round,
      DURING_WINDOW,
      {},
      false,
    );
    assert.ok(apply.isFieldError(out));
    assert.equal(out.stageId, "s2");
    assert.match(out.error, /not been released/i);
  });

  test("answers for a stage that is not on the round are refused", () => {
    const out = apply.readStageAnswers(
      { s9: { q1: "hello" } },
      stages,
      round,
      DURING_WINDOW,
      {},
      false,
    );
    assert.ok(apply.isFieldError(out));
    assert.equal(out.stageId, "s9");
  });

  test("a frozen stage cannot be edited again", () => {
    const out = apply.readStageAnswers(
      { s1: { q1: "second thoughts" } },
      stages,
      round,
      DURING_WINDOW,
      { s1: new Date("2026-10-02T09:00:00Z") },
      false,
    );
    assert.ok(apply.isFieldError(out));
    assert.match(out.error, /already submitted/i);
  });

  test("an unknown option is refused on a draft too", () => {
    const withSelect = [
      makeStage({
        questions: [
          {
            id: "q1",
            type: "singleSelect",
            label: "Stream",
            required: false,
            options: ["Technical", "Governance"],
          },
        ],
      }),
    ];
    const out = apply.readStageAnswers(
      { s1: { q1: "Something else" } },
      withSelect,
      round,
      DURING_WINDOW,
      {},
      false,
    );
    assert.ok(apply.isFieldError(out));
    assert.match(out.error, /unknown option/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Availability off the wire
// ---------------------------------------------------------------------------

describe("readAvailability", () => {
  const round = makeRound();

  test("the ROUND's geometry wins over anything the client claims", () => {
    const mask = apply.readAvailability(
      { version: 9, startMinute: 360, endMinute: 1440, slotMinutes: 5, days: [] },
      round.availabilityGrid,
    );
    assert.equal(apply.isFieldError(mask), false);
    assert.equal(mask.startMinute, GRID.startMinute);
    assert.equal(mask.endMinute, GRID.endMinute);
    assert.equal(mask.slotMinutes, GRID.slotMinutes);
    assert.equal(mask.version, GRID.version);
  });

  test("a missing answer is an empty mask on the round's grid, not an error", () => {
    const mask = apply.readAvailability(undefined, round.availabilityGrid);
    assert.equal(apply.isFieldError(mask), false);
    assert.equal(mask.days.length, 7);
    assert.equal(availability.markedSlotCount(mask), 0);
  });

  test("more day columns than a week is refused", () => {
    const out = apply.readAvailability(
      { days: new Array(9).fill("000000000") },
      round.availabilityGrid,
    );
    assert.ok(apply.isFieldError(out));
  });

  test("a junk column decodes to an empty one rather than to its prefix", () => {
    const mask = apply.readAvailability(
      { days: ["ff0000000", "not hex!!", "", "", "", "", ""] },
      round.availabilityGrid,
    );
    const columns = availability.decodeMask(mask.days, round.availabilityGrid);
    assert.equal(columns[0].slice(0, 8).every(Boolean), true);
    assert.equal(columns[1].some(Boolean), false);
  });

  test("an array where an object belongs is refused", () => {
    assert.ok(apply.isFieldError(apply.readAvailability([], round.availabilityGrid)));
  });
});

// ---------------------------------------------------------------------------
// 5. Programme preference
// ---------------------------------------------------------------------------

describe("readProgrammePreference", () => {
  const round = makeRound();

  test("a stream the round does not run is refused", () => {
    const out = apply.readProgrammePreference({ streamId: "quantum" }, round);
    assert.ok(apply.isFieldError(out));
  });

  test("a fellowship the round does not run is refused", () => {
    const out = apply.readProgrammePreference(
      { rankedFellowshipIds: ["run-tech", "run-nothing"] },
      round,
    );
    assert.ok(apply.isFieldError(out));
  });

  test("the ranking cap is the round's own", () => {
    const out = apply.readProgrammePreference(
      { rankedFellowshipIds: ["run-tech", "run-gov", "run-agi"] },
      round,
    );
    assert.ok(apply.isFieldError(out));
    assert.match(out.error, /at most 2/);
  });

  test("a good answer keeps its order and drops duplicates", () => {
    const out = apply.readProgrammePreference(
      {
        streamId: "governance",
        rankedFellowshipIds: ["run-gov", "run-gov", "run-tech"],
        openToFellowship: true,
      },
      round,
    );
    assert.equal(apply.isFieldError(out), false);
    assert.equal(out.streamId, "governance");
    assert.deepEqual(out.rankedFellowshipIds, ["run-gov", "run-tech"]);
    assert.equal(out.openToFellowship, true);
  });

  test("openToFellowship is dropped when the round never asked the question", () => {
    const noFallback = makeRound({
      programmePreference: {
        ...makeRound().programmePreference,
        offerFellowshipFallback: false,
      },
    });
    const out = apply.readProgrammePreference({ openToFellowship: true }, noFallback);
    assert.equal(out.openToFellowship, false);
  });

  test("a round with the section off stores the empty answer whatever is sent", () => {
    const off = makeRound({
      programmePreference: { ...makeRound().programmePreference, enabled: false },
    });
    const out = apply.readProgrammePreference(
      { streamId: "technical", rankedFellowshipIds: ["run-tech"] },
      off,
    );
    assert.deepEqual(out, {
      streamId: null,
      rankedFellowshipIds: [],
      openToFellowship: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Access requirements: never on the application row
// ---------------------------------------------------------------------------

describe("access requirements", () => {
  test("the answer is capped and trimmed", () => {
    assert.equal(apply.readAccessRequirements("  a step-free room  "), "a step-free room");
    const tooLong = apply.readAccessRequirements("x".repeat(1501));
    assert.ok(apply.isFieldError(tooLong));
    assert.match(tooLong.error, /over its limit/);
  });

  test("a missing answer is an empty string, not an error", () => {
    assert.equal(apply.readAccessRequirements(undefined), "");
  });

  test("the save route writes it ONLY through the private collection reference", () => {
    const src = source(APPLY_ROUTE);
    // It must never be assembled into the application row's update object.
    assert.equal(
      /update\.accessRequirements/.test(src),
      false,
      "the access-requirements answer is being written onto the application row",
    );
    assert.equal(
      /update\[`accessRequirements/.test(src),
      false,
      "the access-requirements answer is being written onto the application row",
    );
    // And it must reach the private row in the SAME batch as the row update,
    // or a crash between the two writes leaves the two halves disagreeing.
    const batch = src.slice(src.indexOf("const batch = db.batch();"));
    assert.match(batch, /batch\.update\(applicationRef\(/);
    assert.match(batch, /batch\.set\(\s*privateRef\(/);
    assert.match(batch, /\{ accessRequirements \}/);
    assert.ok(
      batch.indexOf("await batch.commit()") > batch.indexOf("privateRef("),
      "the private write is not inside the batch",
    );
  });

  test("the owner projection carries the answer and nothing reviewer-only", () => {
    const wire = apply.serialiseApplicationForOwner(
      {
        id: "r__u",
        roundId: "r",
        uid: "u",
        email: "someone@example.com",
        displayName: "Someone",
        stageAnswers: { s1: { q1: "hello" } },
        stageSubmittedAt: { s1: new Date("2026-10-02T09:00:00Z") },
        availability: availability.emptyMask(GRID),
        availabilityConfigVersion: 1,
        programmePreference: {
          streamId: null,
          rankedFellowshipIds: [],
          openToFellowship: false,
        },
        evidence: {
          runs: [],
          facilitatorNotes: "Did not turn up to two sessions.",
          computedAt: null,
        },
        membershipAtApply: true,
        reapplyCount: 0,
        status: "submitted",
        submittedAt: new Date("2026-10-02T09:00:00Z"),
        withdrawnAt: null,
        outcome: {
          decision: "reject",
          targetRunId: null,
          streamId: null,
          decidedByUid: "decider-1",
          decidedAt: new Date("2026-10-25T09:00:00Z"),
          reason: "Not this time, and here is the bit we never shared.",
          reasonShared: false,
        },
        seatApplicationId: null,
        createdAt: null,
        updatedAt: null,
      },
      "a step-free room",
    );

    assert.equal(wire.accessRequirements, "a step-free room");
    const json = JSON.stringify(wire);
    // The two fields the collection's read:false rule exists for.
    assert.equal(json.includes("facilitatorNotes"), false);
    assert.equal(json.includes("Did not turn up"), false);
    assert.equal(json.includes("never shared"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "outcome"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "evidence"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "membershipAtApply"), false);
  });
});

// ---------------------------------------------------------------------------
// 7. The round an applicant sees
// ---------------------------------------------------------------------------

describe("serialiseRoundForApplicant", () => {
  const wire = apply.serialiseRoundForApplicant(makeRound(), DURING_WINDOW);
  const json = JSON.stringify(wire);

  test("the live scoreboard never reaches an applicant", () => {
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "applicationCounts"), false);
    assert.equal(json.includes("applicationCounts"), false);
  });

  test("the people deciding their application are not named", () => {
    assert.equal(json.includes("reviewer-1"), false);
    assert.equal(json.includes("decider-1"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "reviewerUids"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "finalDeciderUid"), false);
  });

  test("what they are scored against is not sent either", () => {
    assert.equal(json.includes("Look for specifics"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "criteria"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wire, "blind"), false);
  });

  test("the window state travels with it, so the page and the routes agree", () => {
    assert.equal(wire.windowState, "open");
    const early = apply.serialiseRoundForApplicant(
      makeRound(),
      new Date("2026-09-01T00:00:00Z"),
    );
    assert.equal(early.windowState, "not-yet");
    const late = apply.serialiseRoundForApplicant(
      makeRound(),
      new Date("2026-11-01T00:00:00Z"),
    );
    assert.equal(late.windowState, "closed");
  });
});

// ---------------------------------------------------------------------------
// 8. The availability grid's state model
// ---------------------------------------------------------------------------

describe("the availability grid round trip", () => {
  test("columns survive a trip through the hex wire format unchanged", () => {
    const columns = model.emptyColumns(GRID);
    // Monday 09:00 to 10:30, Wednesday 16:00 to 18:00, Saturday one quarter.
    let next = model.setRange(columns, 1, 0, 5, true);
    next = model.setRange(next, 3, 28, 35, true);
    next = model.setCell(next, 6, 12, true);

    const mask = model.columnsToMask(next, GRID);
    const back = model.maskToColumns(mask, GRID);
    assert.deepEqual(back, next);
    assert.equal(model.markedCount(back), 6 + 8 + 1);
  });

  test("the mask a round trip produces is what the shared codec reads", () => {
    let columns = model.emptyColumns(GRID);
    columns = model.setRange(columns, 2, 36 - 6, 36 - 1, true); // Tuesday 16:30-18:00
    const mask = model.columnsToMask(columns, GRID);
    assert.equal(availability.markedSlotCount(mask), 6);
    // 16:30 for ninety minutes ends exactly on the 18:00 bound, so it is
    // covered; 16:15 for ninety minutes is not.
    assert.equal(
      availability.maskCoversSession(mask, GRID, {
        weekday: 2,
        startTimeLocal: "16:30",
        durationMinutes: 90,
      }),
      true,
    );
    assert.equal(
      availability.maskCoversSession(mask, GRID, {
        weekday: 2,
        startTimeLocal: "16:15",
        durationMinutes: 90,
      }),
      false,
    );
  });

  test("a range reads the same drawn in either direction", () => {
    const columns = model.emptyColumns(GRID);
    const up = model.setRange(columns, 4, 20, 10, true);
    const down = model.setRange(columns, 4, 10, 20, true);
    assert.deepEqual(up, down);
    assert.equal(model.markedCount(up), 11);
  });

  test("a no-op returns the SAME array, so a drag over painted cells does not re-render", () => {
    let columns = model.setCell(model.emptyColumns(GRID), 1, 3, true);
    assert.equal(model.setCell(columns, 1, 3, true), columns);
    assert.equal(model.setRange(columns, 1, 3, 3, true), columns);
    // Out of bounds is a no-op rather than a throw or a grown column.
    assert.equal(model.setCell(columns, 1, 999, true), columns);
    assert.equal(model.setCell(columns, 99, 0, true), columns);
  });

  test("clearDay clears exactly one column", () => {
    let columns = model.setRange(model.emptyColumns(GRID), 1, 0, 5, true);
    columns = model.setRange(columns, 2, 0, 5, true);
    const cleared = model.clearDay(columns, 1);
    assert.equal(cleared[1].some(Boolean), false);
    assert.equal(cleared[2].filter(Boolean).length, 6);
    // Idempotent, and identity-stable when there is nothing to clear.
    assert.equal(model.clearDay(cleared, 1), cleared);
  });

  test("a mask drawn on a wider grid is trimmed rather than left ragged", () => {
    const wide = { version: 1, startMinute: 8 * 60, endMinute: 20 * 60, slotMinutes: 15 };
    let columns = model.emptyColumns(wide);
    columns = model.setRange(columns, 1, 0, 47, true);
    const mask = model.columnsToMask(columns, wide);
    const onNarrow = model.maskToColumns(mask, GRID);
    for (const column of onNarrow) {
      assert.equal(column.length, availability.slotCountFor(GRID));
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Counter arithmetic, read out of the routes and replayed
// ---------------------------------------------------------------------------

/**
 * Pull `"applicationCounts.<status>": FieldValue.increment(<n>)` out of a slice
 * of route source. Both the literal-key and the computed-key forms, because
 * the withdraw path builds its decrement from the status it is leaving.
 */
function incrementsIn(text) {
  const out = [];
  const literal = /"applicationCounts\.([a-z-]+)":\s*FieldValue\.increment\((-?\d+)\)/g;
  for (const m of text.matchAll(literal)) out.push([m[1], Number(m[2])]);
  const computed = /\[`applicationCounts\.\$\{(\w+)\}`\]:\s*FieldValue\.increment\((-?\d+)\)/g;
  for (const m of text.matchAll(computed)) out.push([`<${m[1]}>`, Number(m[2])]);
  return out;
}

function handler(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start !== -1, `${name} handler not found`);
  const rest = src.slice(start + 1);
  const nextExport = rest.indexOf("\nexport async function ");
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe("the round's counters", () => {
  const applySrc = source(APPLY_ROUTE);
  const submitSrc = source(SUBMIT_ROUTE);

  const post = handler(applySrc, "POST");
  const patch = handler(applySrc, "PATCH");
  const del = handler(applySrc, "DELETE");
  const submit = handler(submitSrc, "POST");

  test("creating a draft adds one draft, and nothing else", () => {
    // Two increments in POST: the create branch and the re-apply branch.
    const found = incrementsIn(post);
    assert.deepEqual(found, [
      ["draft", 1],
      ["withdrawn", -1],
      ["draft", 1],
    ]);
  });

  test("saving a draft moves no counter at all", () => {
    assert.deepEqual(incrementsIn(patch), []);
  });

  test("submitting moves draft down one and submitted up one, exactly once each", () => {
    assert.deepEqual(incrementsIn(submit), [
      ["draft", -1],
      ["submitted", 1],
    ]);
  });

  test("withdrawing takes one off the status it left and adds one withdrawn", () => {
    // `incrementsIn` reports literal keys before computed ones, so the
    // withdrawn side comes first however the source is written.
    assert.deepEqual(incrementsIn(del), [
      ["withdrawn", 1],
      ["<status>", -1],
    ]);
  });

  test("the whole lifecycle leaves the counters where it found them", () => {
    // A model of the transactions the harness cannot run: start from a round's
    // counts, apply the deltas the ROUTES contain (read above, not retyped),
    // and walk one applicant through every path they can take.
    const counts = { draft: 0, submitted: 0, withdrawn: 0 };
    const applyDeltas = (deltas, status) => {
      for (const [key, by] of deltas) {
        const field = key.startsWith("<") ? status : key;
        counts[field] += by;
      }
    };

    // Create.
    applyDeltas([incrementsIn(post)[0]], null);
    assert.deepEqual(counts, { draft: 1, submitted: 0, withdrawn: 0 });

    // Save, twice. Nothing moves.
    applyDeltas(incrementsIn(patch), null);
    applyDeltas(incrementsIn(patch), null);
    assert.deepEqual(counts, { draft: 1, submitted: 0, withdrawn: 0 });

    // Withdraw from draft.
    applyDeltas(incrementsIn(del), "draft");
    assert.deepEqual(counts, { draft: 0, submitted: 0, withdrawn: 1 });

    // Re-apply on the same row: the withdrawn/draft pair, which is the second
    // and third increment in POST.
    applyDeltas(incrementsIn(post).slice(1), null);
    assert.deepEqual(counts, { draft: 1, submitted: 0, withdrawn: 0 });

    // Submit.
    applyDeltas(incrementsIn(submit), null);
    assert.deepEqual(counts, { draft: 0, submitted: 1, withdrawn: 0 });

    // Withdraw from submitted.
    applyDeltas(incrementsIn(del), "submitted");
    assert.deepEqual(counts, { draft: 0, submitted: 0, withdrawn: 1 });
  });

  test("a later stage's submit moves no counter, because the person is already counted", () => {
    assert.deepEqual(incrementsIn(source(STAGE_ROUTE)), []);
  });

  test("every counter move happens inside a transaction with the row it describes", () => {
    for (const [name, text] of [
      ["POST", post],
      ["DELETE", del],
      ["submit", submit],
    ]) {
      const tx = text.indexOf("db.runTransaction(");
      const increment = text.indexOf("FieldValue.increment(");
      assert.ok(
        tx !== -1 && tx < increment,
        `${name} moves a counter outside a transaction: a status that moved without its counter is exactly the drift the recount route exists to repair`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Route prologue pins: throttle first, reCAPTCHA per action, guards
// ---------------------------------------------------------------------------

describe("the route prologue", () => {
  const files = [
    [APPLY_ROUTE, ["POST", "PATCH", "DELETE"]],
    [SUBMIT_ROUTE, ["POST"]],
    [STAGE_ROUTE, ["POST"]],
  ];

  test("every mutating handler guards against view-as before anything else", () => {
    for (const [file, methods] of files) {
      const src = source(file);
      for (const method of methods) {
        const body = handler(src, method);
        const guard = body.indexOf("assertNotImpersonating()");
        assert.ok(guard !== -1, `${file} ${method} does not call the view-as guard`);
        assert.ok(
          guard < 200,
          `${file} ${method} calls the view-as guard, but not at the top of the handler`,
        );
      }
    }
  });

  test("the throttle runs before any datastore read", () => {
    for (const [file, methods] of files) {
      const src = source(file);
      for (const method of methods) {
        const body = handler(src, method);
        const throttle = body.indexOf("throttle(req");
        assert.ok(throttle !== -1, `${file} ${method} is not throttled at all`);
        for (const read of ["loadRound(", "loadOwnApplication(", "loadStages(", "runTransaction("]) {
          const at = body.indexOf(read);
          if (at === -1) continue;
          assert.ok(
            throttle < at,
            `${file} ${method} reads (${read}) before it throttles: the point of throttling is to cap cost, so a limiter after the read has already paid for the request it is about to refuse`,
          );
        }
      }
    }
  });

  test("the IP axis runs before the session lookup, and the uid axis after it", () => {
    for (const [file, methods] of files) {
      const src = source(file);
      for (const method of methods) {
        const body = handler(src, method);
        const ip = body.indexOf("throttle(req, null,");
        const session = body.indexOf("requireApplicant()");
        const uid = body.indexOf("throttle(req, user.uid,");
        assert.ok(ip !== -1, `${file} ${method} has no per-IP throttle`);
        assert.ok(ip < session, `${file} ${method} looks up the session before throttling by IP`);
        if (uid !== -1) assert.ok(session < uid, `${file} ${method} throttles by uid before it has one`);
      }
    }
  });

  test("reCAPTCHA is verified on each deliberate action, and NOT on the autosave", () => {
    const applySrc = source(APPLY_ROUTE);
    assert.match(handler(applySrc, "POST"), /requireRecaptcha\(body, "create"\)/);
    assert.match(handler(source(SUBMIT_ROUTE), "POST"), /requireRecaptcha\(body, "submit"\)/);
    assert.match(
      handler(source(STAGE_ROUTE), "POST"),
      /requireRecaptcha\(body, "stage-submit"\)/,
    );
    // The draft save deliberately carries no token: a Google token goes stale
    // in about two minutes and the autosave fires on a timer with nobody
    // watching. See the note in applyRoutes.ts.
    assert.equal(
      /requireRecaptcha/.test(handler(applySrc, "PATCH")),
      false,
      "the autosave mints a reCAPTCHA token, which would pop a challenge over a half-written essay on a 120-second timer",
    );
  });

  test("each verified action names an action the shared list knows about", () => {
    const actions = new Set(apply.RECAPTCHA_ACTIONS);
    const named = [
      ...source(APPLY_ROUTE).matchAll(/requireRecaptcha\(body, "([a-z-]+)"\)/g),
      ...source(SUBMIT_ROUTE).matchAll(/requireRecaptcha\(body, "([a-z-]+)"\)/g),
      ...source(STAGE_ROUTE).matchAll(/requireRecaptcha\(body, "([a-z-]+)"\)/g),
    ].map((m) => m[1]);
    assert.ok(named.length >= 3);
    for (const action of named) assert.ok(actions.has(action), `unknown action ${action}`);
  });

  test("the maintenance pause gates the writes that create work, and not the save", () => {
    const applySrc = source(APPLY_ROUTE);
    assert.match(handler(applySrc, "POST"), /applicationsPaused\(db\)/);
    assert.match(handler(source(SUBMIT_ROUTE), "POST"), /applicationsPaused\(db\)/);
    // Deliberately ungated: stranding somebody mid-sentence with an
    // unsaveable form during a maintenance pause helps nobody, and the row
    // already exists so the save costs one write.
    assert.equal(/applicationsPaused/.test(handler(applySrc, "PATCH")), false);
    // And withdrawing must never be blocked by a pause either: that would trap
    // somebody in a queue with no exit.
    assert.equal(/applicationsPaused/.test(handler(applySrc, "DELETE")), false);
  });

  test("the draft save refuses once the application is no longer a draft", () => {
    assert.match(
      handler(source(APPLY_ROUTE), "PATCH"),
      /if \(application\.status !== "draft"\)/,
    );
  });

  test("withdrawing needs a typed confirmation", () => {
    const del = handler(source(APPLY_ROUTE), "DELETE");
    assert.match(del, /WITHDRAW_CONFIRMATION/);
    assert.match(del, /status: 400/);
  });

  test("the submit re-validates with required questions enforced", () => {
    const submit = handler(source(SUBMIT_ROUTE), "POST");
    assert.match(submit, /enforceRequired: true/);
    assert.match(submit, /membershipAtApply/);
    assert.match(submit, /round\.academicYear/);
  });

  test("the submit validates what is STORED, never a payload from the request", () => {
    const submit = handler(source(SUBMIT_ROUTE), "POST");
    assert.match(submit, /application\.stageAnswers\[stage\.id\]/);
    assert.equal(
      /validateAnswers\(stage\.questions, body\./.test(submit),
      false,
      "the submit route is validating request-body answers, so the version reviewed depends on which request landed second",
    );
  });

  test("the later-stage submit checks the release boundary on the write side too", () => {
    const stage = handler(source(STAGE_ROUTE), "POST");
    assert.match(stage, /isStageReleased\(stage, round, now\)/);
    assert.match(stage, /enforceRequired: true/);
  });

  test("the applicant's email comes from the session, never the body", () => {
    const post = handler(source(APPLY_ROUTE), "POST");
    assert.match(post, /email: user\.email \?\? null/);
    assert.equal(/email: body\./.test(post), false);
  });

  test("re-applying unfreezes the stages, or the reopened draft is uneditable", () => {
    const post = handler(source(APPLY_ROUTE), "POST");
    const reopen = post.slice(post.indexOf('status === "withdrawn"'));
    assert.match(reopen, /stageSubmittedAt: \{\},/);
    assert.match(reopen, /withdrawnAt: null,/);
    assert.match(reopen, /reapplyCount: FieldValue\.increment\(1\)/);
    // The save route refuses a frozen stage by design, so a reopened draft
    // that kept its freezes would be a form somebody can read and never edit.
    assert.match(
      handler(source(APPLY_ROUTE), "PATCH"),
      /application\.stageSubmittedAt/,
    );
  });

  test("a 409 on create carries the existing row so a double tap opens the draft", () => {
    const post = handler(source(APPLY_ROUTE), "POST");
    const conflict = post.slice(post.indexOf('outcome === "exists"'));
    assert.match(conflict, /application,/);
    assert.match(conflict, /status: 409/);
  });
});

// ---------------------------------------------------------------------------
// 11. The register-then-apply return address
// ---------------------------------------------------------------------------

describe("the funnel return allowlist", () => {
  test("both funnels are accepted", () => {
    assert.equal(authReturn.safeFunnelReturn("/apply/autumn-2026__abc"), "/apply/autumn-2026__abc");
    assert.equal(authReturn.safeFunnelReturn("/courses/intro/apply"), "/courses/intro/apply");
    assert.equal(authReturn.isFunnelReturn("/apply/x"), true);
  });

  test("everything that is not one of those two is refused", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "/admin",
      "/dashboard",
      "/applyx",
      "//evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "/apply/..%2fadmin".replace("%2f", "/"),
      "/courses/../admin",
      "/apply/../../admin",
    ]) {
      assert.equal(
        authReturn.safeFunnelReturn(bad),
        null,
        `${String(bad)} was accepted as a return address`,
      );
    }
  });

  test("a control character anywhere in the path is refused", () => {
    const withNewline = `/apply/x${String.fromCharCode(10)}y`;
    assert.equal(authReturn.safeFunnelReturn(withNewline), null);
  });

  test("a query string containing dots is not a traversal", () => {
    assert.equal(
      authReturn.safeFunnelReturn("/apply/round?from=.."),
      "/apply/round?from=..",
    );
  });

  test("both auth surfaces read the shared allowlist rather than their own copy", () => {
    const register = source("src/app/(auth)/register/page.tsx");
    const entry = source("src/app/(auth)/AuthEntry.tsx");
    assert.match(register, /from "@\/lib\/authReturn"/);
    assert.match(entry, /from "@\/lib\/authReturn"/);
    // Neither may keep a hand-rolled prefix test of its own.
    assert.equal(/startsWith\("\/courses\/"\)/.test(register), false);
    assert.equal(/startsWith\("\/courses\/"\)/.test(entry), false);
  });
});

// ---------------------------------------------------------------------------
// 12. The page's gate
// ---------------------------------------------------------------------------

describe("the apply page", () => {
  const page = source("src/app/(public)/apply/[roundId]/page.tsx");

  test("it lives in the (public) group, so a role-pending account reaches it", () => {
    assert.ok(
      existsSync(join(REPO_ROOT, "src/app/(public)/apply/[roundId]/page.tsx")),
      "the apply page is not in the (public) route group",
    );
  });

  test("a signed-out visitor gets a gate card carrying the return address", () => {
    assert.match(page, /\/login\?next=\$\{nextParam\}/);
    assert.match(page, /\/register\?next=\$\{nextParam\}/);
    assert.match(page, /\/apply\/\$\{encodeURIComponent\(roundId\)\}/);
  });

  test("a draft or archived round is a 404", () => {
    assert.match(page, /round\.archived \|\| round\.status === "draft"/);
    assert.match(page, /notFound\(\)/);
  });

  test("it serialises through the same applicant-only functions the routes use", () => {
    assert.match(page, /serialiseRoundForApplicant/);
    assert.match(page, /serialiseStageForApplicant/);
    assert.match(page, /serialiseApplicationForOwner/);
    assert.equal(
      /serialiseRound\(/.test(page),
      false,
      "the page calls the staff round serialiser, which carries the counters and the final decider",
    );
  });

  test("a closed round still renders for somebody holding a row", () => {
    // The 404 is keyed on draft/archived ONLY. A closed window falls through
    // to the flow, which renders the application view-only.
    const guard = page.slice(page.indexOf("if (round.archived"), page.indexOf("const now"));
    assert.equal(/windowState/.test(guard), false);
    assert.equal(/closesAt/.test(guard), false);
  });

  test("the proxy does not intercept it, so the gate card is what a visitor sees", () => {
    const proxy = source("src/proxy.ts");
    assert.equal(
      /"\/apply"/.test(proxy),
      false,
      "adding /apply to the protected prefixes would redirect a signed-out visitor to /login, from which the round is invisible",
    );
  });
});

// ---------------------------------------------------------------------------
// 13. The client island's contract with the routes
// ---------------------------------------------------------------------------

describe("the apply flow island", () => {
  const flow = source("src/features/admissions/ApplyFlow.tsx");
  const client = source("src/features/admissions/applyClient.ts");

  test("the privacy notice is mounted, not recreated", () => {
    assert.match(flow, /import ApplicationPrivacyNotice from "\.\/ApplicationPrivacyNotice"/);
    assert.match(flow, /<ApplicationPrivacyNotice/);
  });

  test("member-authored text renders through MemberText and nothing else", () => {
    assert.match(flow, /<MemberText/);
    assert.equal(/dangerouslySetInnerHTML/.test(flow), false);
  });

  test("the reCAPTCHA token is minted per action, never at page load", () => {
    // `token()` is called inside the action handlers, and the widget's execute
    // is never run from an effect.
    assert.match(flow, /await token\(\)/);
    assert.equal(
      /useEffect\([^)]*recaptcha/.test(flow),
      false,
      "a token minted at page load would be stale by the time a long answer is submitted",
    );
  });

  test("submitting saves first, because the route validates what is stored", () => {
    const submit = flow.slice(flow.indexOf("async function onSubmit()"));
    assert.match(submit, /if \(dirty && !\(await onSave\(\)\)\) return;/);
  });

  test("a 409 from the create call opens the draft it carries", () => {
    const start = flow.slice(flow.indexOf("async function onStart()"));
    assert.match(start, /err\.status === 409 && err\.application/);
    assert.match(client, /application\?: ApplicantApplication \| null;/);
  });

  test("a later stage is only offered while the window is open", () => {
    // `isStageReleased` deliberately keeps saying yes after the deadline, so
    // reviewers can read the questions. Without the window check the flow
    // would render a live form against a route that refuses every POST.
    assert.match(flow, /const laterStagesOpen = status === "submitted" && windowOpen;/);
    assert.match(flow, /stageEditable = editable \|\| \(laterStagesOpen && !frozen\)/);
    assert.match(flow, /\{laterStagesOpen && !frozen \? \(/);
  });

  test("a closed window with an unsent draft says so rather than claiming it was sent", () => {
    assert.match(flow, /This one was never sent/);
    assert.match(flow, /The window closed while this was still a draft/);
  });

  test("the save bar autosaves on the interval the contract names", () => {
    const bar = source("src/features/admissions/DraftSaveBar.tsx");
    assert.match(bar, /AUTOSAVE_INTERVAL_MS = 120_000/);
    assert.match(bar, /beforeunload/);
    // The unload guard is registered only while dirty, or it trains people to
    // click through the one that matters.
    const listener = bar.indexOf('window.addEventListener("beforeunload"');
    assert.ok(listener !== -1, "the unload guard is never registered");
    const guard = bar.slice(0, listener);
    assert.match(
      guard.slice(guard.lastIndexOf("useEffect")),
      /if \(!dirty\) return;/,
    );
  });

  test("the availability grid locks the document only while a drag is live", () => {
    const grid = source("src/features/admissions/AvailabilityGrid.tsx");
    assert.match(grid, /useBodyScrollLock\(dragging\)/);
    // One delegated handler on the container, not 252 listeners.
    assert.match(grid, /onPointerDown=\{onPointerDown\}/);
    assert.equal(/onClick=\{\(\) => toggle/.test(grid), false);
    // Roving tabindex.
    assert.match(grid, /tabIndex=\{cursor\.day === day && cursor\.slot === slot \? 0 : -1\}/);
  });

  test("the grid stylesheet is mobile-first and hides the other days on a phone", () => {
    const css = source("src/features/admissions/AvailabilityGrid.module.css");
    assert.match(css, /\.column\[data-active="false"\] \{\s*display: none;/);
    assert.match(css, /@media \(min-width: 48rem\)/);
    assert.match(css, /touch-action: none;/);
    assert.match(css, /touch-action: pan-y;/);
  });
});
