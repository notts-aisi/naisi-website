/**
 * Unit tests for the three ADMISSIONS SHARED MODULES, plus source pins on the
 * account-deletion sweep that cannot be executed without a database.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth testing here, and why
 *
 * Each of the three modules is the ONLY implementation of something two
 * surfaces would otherwise implement twice:
 *
 *  1. **`window.ts`**: whether you can apply. The courses version of this
 *     exists because discovery and submit disagreed and an applicant wrote
 *     five hundred words into a form the route then refused. A round has the
 *     same two halves and would grow the same bug.
 *  2. **`stageRelease.ts`**: whether a question may be served yet. This one
 *     is not a convenience: it is the entire timed-release guarantee. The
 *     stages subcollection is `allow read, write: if false` precisely so that
 *     nothing but a route which called `isStageReleased` can put a question
 *     on the wire, which means a bug here is a fairness failure, not a
 *     display bug.
 *  3. **`availability.ts`**: one hex codec. The decide route resolves seat
 *     labels through it and the allocation board's conflict warning is built
 *     on those labels, so a bit-order or bounds mistake blanks the one screen
 *     whose whole job is putting people into session slots.
 *
 * ## The London cases are the point of several of these
 *
 * Every date an admin types is a Europe/London civil date; every comparison
 * is on instants. Between those two lives the class of bug that names a
 * deadline a day early, or releases a question an hour before it was
 * announced on the far side of a clock change. Those are tested explicitly
 * (§2.4, §3.4) rather than left to the fact that the helpers being called
 * have their own tests.
 *
 * ## Why the loader dance
 *
 * Same root cause as `course-window.test.mjs`: this repo's Node predates the
 * v22.18 that strips TypeScript natively, so the module graph is transpiled
 * in memory with the `typescript` devDependency `npx tsc --noEmit` already
 * uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Nothing under `lib/admissions` imports a server-only module today, and the
 * stub is here so that a future import cannot drag one into a unit test
 * unnoticed. `availability.ts` and `window.ts` reaching for `firebase-admin`
 * would be a design mistake worth failing on, not a loader problem to solve.
 */
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

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code.
// ---------------------------------------------------------------------------

const {
  AVAILABILITY_DAYS,
  AVAILABILITY_VERSION,
  DEFAULT_AVAILABILITY_GRID,
  decodeMask,
  emptyMask,
  encodeMask,
  hexCharsPerDay,
  markedSlotCount,
  maskCoversSession,
  minutesFromTimeLocal,
  normalizeAvailabilityGrid,
  normalizeAvailabilityMask,
  slotCountFor,
  slotLabels,
} = await loadTs("lib/admissions/availability.ts");

const { formatRoundDate, formatRoundDeadline, isRoundOpen, roundWindowState } =
  await loadTs("lib/admissions/window.ts");

const {
  DEFAULT_STAGE_RELEASE_TIME,
  effectiveStageClose,
  isStageReleased,
  stageReleaseInstant,
} = await loadTs("lib/admissions/stageRelease.ts");

const {
  ADMISSION_ROUND_STATUSES,
  ADMISSION_ROUND_TRANSITIONS,
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} = await loadTs("lib/firestore/admissionRounds.ts");

const {
  ADMISSION_APPLICATION_STATUSES,
  admissionApplicationId,
  admissionApplicationPrivateId,
  normalizeAdmissionApplication,
} = await loadTs("lib/firestore/admissionApplications.ts");

const { admissionReviewId, normalizeAdmissionReview, reviewTotal } = await loadTs(
  "lib/firestore/admissionReviews.ts",
);

const { normalizeAdmissionApplicationPrivate } = await loadTs(
  "lib/firestore/admissionApplicationPrivate.ts",
);

const { conductChip, normalizeMemberConductFlag } = await loadTs(
  "lib/firestore/memberConductFlags.ts",
);

// ---------------------------------------------------------------------------
// Source handles for the parts that cannot be imported (`server-only`).
// ---------------------------------------------------------------------------

const src = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

const ACCOUNT_DELETION = src("lib", "firestore", "accountDeletion.ts");
const AVAILABILITY_SRC = src("lib", "admissions", "availability.ts");
const ROUNDS_SRC = src("lib", "firestore", "admissionRounds.ts");

/** Comments stripped: several guards below ask "does the code do X", and the
 *  comments in these files name the very things being asserted absent. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ACCOUNT_DELETION_CODE = stripComments(ACCOUNT_DELETION);
const AVAILABILITY_CODE = stripComments(AVAILABILITY_SRC);
const ROUNDS_CODE = stripComments(ROUNDS_SRC);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Mon 21 Sep 2026, 09:00 London (BST): the real autumn opening. */
const OPENS = new Date("2026-09-21T08:00:00Z");
/** Sun 18 Oct 2026, 23:59 London (BST): the real autumn deadline. */
const CLOSES = new Date("2026-10-18T22:59:00Z");

const INSIDE = new Date("2026-10-01T12:00:00Z");
const BEFORE = new Date("2026-09-01T12:00:00Z");
const AFTER = new Date("2026-11-01T12:00:00Z");

function round(overrides = {}) {
  return {
    status: "open",
    archived: false,
    opensAt: OPENS,
    closesAt: CLOSES,
    ...overrides,
  };
}

function stage(overrides = {}) {
  return {
    releaseAt: null,
    releaseTimeLocal: DEFAULT_STAGE_RELEASE_TIME,
    manualReleasedAt: null,
    closesAt: null,
    ...overrides,
  };
}

const GRID = DEFAULT_AVAILABILITY_GRID;

/** A day column with the given slot indices marked. */
function column(...slots) {
  const out = new Array(slotCountFor(GRID)).fill(false);
  for (const i of slots) out[i] = true;
  return out;
}

/** A mask marking the given slot indices on the given weekday, nothing else. */
function maskOn(weekday, ...slots) {
  const days = new Array(AVAILABILITY_DAYS).fill(null).map(() => []);
  days[weekday] = column(...slots);
  return { ...GRID, days: encodeMask(days, GRID) };
}

// ===========================================================================
// §1 AVAILABILITY: the codec
// ===========================================================================

test("the default grid is the 252 cells the apply page is built around", () => {
  // 09:00 to 18:00 in quarter hours. If this number moves, the grid component
  // and every seat label move with it, so it is worth stating once.
  assert.equal(slotCountFor(GRID), 36);
  assert.equal(hexCharsPerDay(GRID), 9);
  assert.equal(slotCountFor(GRID) * AVAILABILITY_DAYS, 252);
  assert.equal(GRID.startMinute, 540);
  assert.equal(GRID.endMinute, 1080);
});

test("slot labels are London wall clocks, in time order, starting at the bound", () => {
  const labels = slotLabels(GRID);
  assert.equal(labels.length, 36);
  assert.equal(labels[0], "09:00");
  assert.equal(labels[1], "09:15");
  assert.equal(labels[4], "10:00");
  // The LAST slot starts at 17:45 and ends on the exclusive 18:00 bound. A
  // labels array ending at "18:00" would mean the grid offers a slot running
  // to 18:15, which is outside the window the round advertised.
  assert.equal(labels[35], "17:45");
});

test("a mask round-trips, and the earliest slot is the leftmost bit", () => {
  // Slot 0 is the HIGH bit of the first hex character, so the string reads
  // left to right in time order. Somebody will read one of these in the
  // Firebase console during an intake; this is the only ordering that
  // survives that.
  const days = new Array(7).fill(null).map(() => []);
  days[2] = column(0);
  assert.equal(encodeMask(days, GRID)[2], "800000000");

  days[2] = column(3);
  assert.equal(encodeMask(days, GRID)[2], "100000000");

  days[2] = column(4);
  assert.equal(encodeMask(days, GRID)[2], "080000000");

  days[2] = column(0, 1, 2, 3);
  assert.equal(encodeMask(days, GRID)[2], "f00000000");

  const drawn = column(0, 5, 17, 35);
  const all = new Array(7).fill(null).map(() => []);
  all[6] = drawn;
  assert.deepEqual(decodeMask(encodeMask(all, GRID), GRID)[6], drawn);
});

test("padding bits past the last real slot never decode as availability", () => {
  // 36 slots need 9 hex characters, which hold 36 bits exactly, so the
  // default grid has no padding. A grid that does not divide by four is the
  // case that matters: 10 slots need 3 characters holding 12 bits.
  const odd = { ...GRID, endMinute: GRID.startMinute + 10 * 15 };
  assert.equal(slotCountFor(odd), 10);
  assert.equal(hexCharsPerDay(odd), 3);

  const marked = new Array(10).fill(true);
  const days = new Array(7).fill(null).map(() => []);
  days[0] = marked;
  const encoded = encodeMask(days, odd)[0];
  // Last character holds slots 8 and 9 in its two high bits; the two low bits
  // are padding and must be written as zero.
  assert.equal(encoded, "ffc");
  assert.deepEqual(decodeMask([encoded], odd)[0], marked);

  // And a hand-edited row that set the padding bits decodes to the same ten.
  assert.deepEqual(decodeMask(["fff"], odd)[0], marked);
});

test("a malformed day column decodes EMPTY, never to its readable prefix", () => {
  // The two failure directions are not symmetrical. Reading junk as
  // "available" puts somebody in a session they never offered; reading it as
  // "not available" costs a conflict warning nobody wanted.
  for (const bad of ["nonsense", "F00000000", "8000000000", 42, null, undefined, {}]) {
    assert.deepEqual(
      decodeMask([bad], GRID)[0],
      new Array(36).fill(false),
      `"${String(bad)}" decoded to something`,
    );
  }
  // A SHORT but well-formed string is not malformed: it is a day whose later
  // slots are simply unset, and it decodes to exactly what it says.
  assert.deepEqual(decodeMask(["8"], GRID)[0], column(0));
});

test("decode always yields exactly seven columns, whatever was stored", () => {
  for (const stored of [undefined, [], ["800000000"], new Array(20).fill("0")]) {
    assert.equal(decodeMask(stored, GRID).length, 7);
  }
  assert.equal(emptyMask(GRID).days.length, 7);
  assert.equal(markedSlotCount(emptyMask(GRID)), 0);
  assert.equal(markedSlotCount(maskOn(1, 0, 1, 2)), 3);
});

// ---------------------------------------------------------------------------
// §1.2 The geometry travels with the answer
// ---------------------------------------------------------------------------

test("an answer is decoded against the grid it was DRAWN on, not the round's current one", () => {
  // THE reason `AvailabilityMask` duplicates the grid. Widening a round's
  // window is meant to be a config edit; if the answer were read against the
  // NEW geometry, bit 0 would silently move from 09:00 to 08:00 and every
  // already-submitted answer would shift an hour earlier.
  const oldGrid = { ...GRID };
  const drawnAtNine = { ...oldGrid, days: maskOn(2, 0).days };

  const widened = { ...GRID, startMinute: 8 * 60 };
  assert.equal(slotCountFor(widened), 40);

  // Tuesday 09:00 for 15 minutes: covered, because the answer still means
  // 09:00. Read against the widened grid it would mean 08:00 and this would
  // be false.
  assert.equal(
    maskCoversSession(drawnAtNine, widened, {
      weekday: 2,
      startTimeLocal: "09:00",
      durationMinutes: 15,
    }),
    true,
  );
  // And 08:00 is NOT covered, which is the mirror of the same property.
  assert.equal(
    maskCoversSession(drawnAtNine, widened, {
      weekday: 2,
      startTimeLocal: "08:00",
      durationMinutes: 15,
    }),
    false,
  );
});

test("the round's grid is used only when the stored answer carries none", () => {
  const legacy = { days: maskOn(3, 0).days };
  assert.equal(
    maskCoversSession(legacy, GRID, {
      weekday: 3,
      startTimeLocal: "09:00",
      durationMinutes: 15,
    }),
    true,
  );
  // With no geometry anywhere there is nothing to decode against, so the
  // answer is "no", never a guess.
  assert.equal(
    maskCoversSession(legacy, { version: 1, startMinute: 0, endMinute: 0, slotMinutes: 0 }, {
      weekday: 3,
      startTimeLocal: "09:00",
      durationMinutes: 15,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// §1.3 maskCoversSession
// ---------------------------------------------------------------------------

test("a session is covered only when EVERY slot it touches is marked", () => {
  // 18:00 for 90 minutes is the shape a real group meets in, but it is
  // outside a 09:00-18:00 grid, so the realistic in-window case is used here
  // and the out-of-window one has its own test below.
  const session = { weekday: 2, startTimeLocal: "14:00", durationMinutes: 90 };
  // 14:00 is slot 20; 90 minutes is six slots, 20 through 25.
  assert.equal(maskCoversSession(maskOn(2, 20, 21, 22, 23, 24, 25), GRID, session), true);
  // Missing the last one: they can make the first hour, not the session.
  assert.equal(maskCoversSession(maskOn(2, 20, 21, 22, 23, 24), GRID, session), false);
  // Missing the first one.
  assert.equal(maskCoversSession(maskOn(2, 21, 22, 23, 24, 25), GRID, session), false);
});

test("a session finishing exactly on a slot boundary does not need the slot after it", () => {
  // `end` is exclusive. 14:00 for 30 minutes is slots 20 and 21 and finishes
  // at 14:30, which is where slot 22 begins; requiring 22 would make every
  // session need one more quarter hour than it takes.
  const session = { weekday: 4, startTimeLocal: "14:00", durationMinutes: 30 };
  assert.equal(maskCoversSession(maskOn(4, 20, 21), GRID, session), true);
  assert.equal(maskCoversSession(maskOn(4, 20), GRID, session), false);
});

test("a session starting mid-slot needs the slot it starts inside", () => {
  // 14:05 for 20 minutes runs 14:05 to 14:25: it touches slot 20 (14:00) and
  // slot 21 (14:15). Flooring the start is what makes the partial first slot
  // required rather than skipped.
  const session = { weekday: 5, startTimeLocal: "14:05", durationMinutes: 20 };
  assert.equal(maskCoversSession(maskOn(5, 20, 21), GRID, session), true);
  assert.equal(maskCoversSession(maskOn(5, 21), GRID, session), false);
});

test("a session outside the grid is NOT covered, whatever is marked", () => {
  // The applicant was never shown that time. Treating unmarked-because-
  // -unaskable as available would invent consent out of the grid's bounds.
  //
  // The rule is enforced twice on purpose (an early exit on the minute bounds
  // and a range guard inside the slot loop), so removing either one alone
  // leaves this test green. That is stated in `availability.ts` beside the
  // early exit rather than left for someone to discover by deleting it.
  const everything = {
    ...GRID,
    days: encodeMask(
      new Array(7).fill(null).map(() => new Array(36).fill(true)),
      GRID,
    ),
  };
  // Starts before the grid opens.
  assert.equal(
    maskCoversSession(everything, GRID, {
      weekday: 1,
      startTimeLocal: "08:30",
      durationMinutes: 60,
    }),
    false,
  );
  // Runs past the grid's close: 17:45 for 30 minutes ends at 18:15.
  assert.equal(
    maskCoversSession(everything, GRID, {
      weekday: 1,
      startTimeLocal: "17:45",
      durationMinutes: 30,
    }),
    false,
  );
  // The last legal session ends exactly on the bound.
  assert.equal(
    maskCoversSession(everything, GRID, {
      weekday: 1,
      startTimeLocal: "17:45",
      durationMinutes: 15,
    }),
    true,
  );
});

test("the weekday index is the Date.getDay() convention, and only 0..6 exist", () => {
  // If this ever disagrees with `GroupSession.weekday`, every availability
  // chip on the allocation board is off by some number of days and nothing in
  // the UI would say so.
  const monday = maskOn(1, 20, 21);
  const session = { startTimeLocal: "14:00", durationMinutes: 30 };
  assert.equal(maskCoversSession(monday, GRID, { ...session, weekday: 1 }), true);
  assert.equal(maskCoversSession(monday, GRID, { ...session, weekday: 0 }), false);
  assert.equal(maskCoversSession(monday, GRID, { ...session, weekday: 2 }), false);
  for (const weekday of [-1, 7, 1.5, "1", null, undefined, NaN]) {
    assert.equal(maskCoversSession(monday, GRID, { ...session, weekday }), false);
  }
  // Saturday and Sunday are first-class columns, not an afterthought: the
  // fairs run on a Saturday and a Sunday.
  assert.equal(
    maskCoversSession(maskOn(0, 20, 21), GRID, { ...session, weekday: 0 }),
    true,
  );
  assert.equal(
    maskCoversSession(maskOn(6, 20, 21), GRID, { ...session, weekday: 6 }),
    true,
  );
});

test("a malformed session is refused rather than coerced into a slot range", () => {
  const everything = {
    ...GRID,
    days: encodeMask(
      new Array(7).fill(null).map(() => new Array(36).fill(true)),
      GRID,
    ),
  };
  for (const bad of [
    { weekday: 1, startTimeLocal: "25:00", durationMinutes: 30 },
    { weekday: 1, startTimeLocal: "9:00", durationMinutes: 30 },
    { weekday: 1, startTimeLocal: "", durationMinutes: 30 },
    { weekday: 1, startTimeLocal: "14:00", durationMinutes: 0 },
    { weekday: 1, startTimeLocal: "14:00", durationMinutes: -30 },
    { weekday: 1, startTimeLocal: "14:00", durationMinutes: Number.NaN },
    { weekday: 1, startTimeLocal: "14:00" },
  ]) {
    assert.equal(maskCoversSession(everything, GRID, bad), false);
  }
  assert.equal(minutesFromTimeLocal("09:15"), 555);
  assert.equal(minutesFromTimeLocal("24:00"), null);
});

// ---------------------------------------------------------------------------
// §1.4 The London property: there is no clock in this module
// ---------------------------------------------------------------------------

test("the codec is pure wall clock, so no clock change can move a slot", () => {
  // Every number in `availability.ts` is minutes past a London midnight on an
  // unspecified day plus a weekday index. An applicant is answering "most
  // Tuesdays", not "Tuesday 27 October", so the same drawn grid must mean the
  // same thing in BST and in GMT.
  //
  // The strongest form of that guarantee is that the module cannot express a
  // date at all: no instant is constructed, so there is nothing for a DST
  // transition to act on. Asserted at the source, because a behavioural test
  // can only sample dates it thought of.
  assert.doesNotMatch(AVAILABILITY_CODE, /new Date\(/);
  assert.doesNotMatch(AVAILABILITY_CODE, /Date\.now\(/);
  assert.doesNotMatch(AVAILABILITY_CODE, /Intl\.DateTimeFormat/);
  assert.doesNotMatch(AVAILABILITY_CODE, /londonWallClockToInstant/);

  // And the behavioural half: `maskCoversSession` takes no instant, so a
  // caller cannot accidentally make the answer depend on one.
  assert.equal(maskCoversSession.length, 3);
});

test("normalisers repair a stored grid whole, never field by field", () => {
  assert.deepEqual(normalizeAvailabilityGrid(undefined), GRID);
  // Half of one grid and half of another is a geometry nobody chose.
  assert.deepEqual(
    normalizeAvailabilityGrid({ startMinute: 600, endMinute: 540, slotMinutes: 15 }),
    GRID,
  );
  assert.deepEqual(
    normalizeAvailabilityGrid({
      version: 1,
      startMinute: 480,
      endMinute: 1200,
      slotMinutes: 30,
    }),
    { version: 1, startMinute: 480, endMinute: 1200, slotMinutes: 30 },
  );

  const repaired = normalizeAvailabilityMask({ days: ["zzz"] }, GRID);
  assert.equal(repaired.days.length, 7);
  assert.equal(markedSlotCount(repaired), 0);
  assert.equal(repaired.version, AVAILABILITY_VERSION);
});

// ===========================================================================
// §2 WINDOW: can you apply
// ===========================================================================

test("a draft round is inactive, whatever its dates say", () => {
  const w = roundWindowState(round({ status: "draft" }), INSIDE);
  assert.equal(w.state, "inactive");
  assert.equal(isRoundOpen(round({ status: "draft" }), INSIDE), false);
});

test("an archived round is inactive even while its status still says open", () => {
  assert.equal(roundWindowState(round({ archived: true }), INSIDE).state, "inactive");
});

test("the status matrix is exhaustive over AdmissionRoundStatus", () => {
  // A new status added to the union without a decision here would fall
  // through to `closed`, which is the survivable direction but is a decision
  // somebody should have made on purpose.
  const expected = {
    draft: "inactive",
    open: "open",
    closed: "closed",
    deciding: "closed",
    settled: "closed",
    cancelled: "closed",
  };
  assert.deepEqual(Object.keys(expected).sort(), [...ADMISSION_ROUND_STATUSES].sort());
  for (const status of ADMISSION_ROUND_STATUSES) {
    assert.equal(
      roundWindowState(round({ status }), INSIDE).state,
      expected[status],
      `status ${status}`,
    );
  }
});

test("status beats the dates: closed early stays closed inside the window", () => {
  // The status is an admin's deliberate act; the date is a schedule.
  assert.equal(roundWindowState(round({ status: "closed" }), INSIDE).state, "closed");
});

test("both bounds are INCLUSIVE, and the autumn deadline is the case that matters", () => {
  // 23:59 London on Sunday 18 October. 23:59:00.000 is the last accepted
  // instant, which is what "closes at 23:59" reads as to a person.
  assert.equal(roundWindowState(round(), CLOSES).state, "open");
  assert.equal(
    roundWindowState(round(), new Date(CLOSES.getTime() + 1)).state,
    "closed",
  );
  assert.equal(roundWindowState(round(), OPENS).state, "open");
  assert.equal(
    roundWindowState(round(), new Date(OPENS.getTime() - 1)).state,
    "not-yet",
  );
});

test("a null bound is unbounded, never closed", () => {
  // Reading null as "no window, therefore shut" would silently close every
  // rolling round on the site.
  assert.equal(roundWindowState(round({ closesAt: null }), AFTER).state, "open");
  assert.equal(roundWindowState(round({ opensAt: null }), BEFORE).state, "open");
  assert.equal(
    roundWindowState(round({ opensAt: null, closesAt: null }), AFTER).state,
    "open",
  );
});

test("opensAt and closesAt are echoed back in every state", () => {
  for (const status of ADMISSION_ROUND_STATUSES) {
    const w = roundWindowState(round({ status }), INSIDE);
    assert.equal(w.opensAt, OPENS);
    assert.equal(w.closesAt, CLOSES);
  }
  const undef = roundWindowState(
    { status: "open", archived: false, opensAt: undefined, closesAt: undefined },
    INSIDE,
  );
  assert.equal(undef.opensAt, null);
  assert.equal(undef.closesAt, null);
});

// ---------------------------------------------------------------------------
// §2.4 THE LONDON DAY BOUNDARY
// ---------------------------------------------------------------------------

test("LONDON: a deadline late in the evening is never named a day early", () => {
  // The bug this exists to catch: formatting a deadline in UTC. During BST an
  // instant after 23:00 UTC is already the NEXT calendar day in London, so a
  // UTC-formatted label names the wrong day, and an applicant reads "you have
  // until Tuesday" for a deadline that expires on Wednesday.
  const lateJune = new Date("2026-06-30T23:30:00Z"); // 1 Jul, 00:30 BST
  assert.equal(formatRoundDate(lateJune), "Wed 1 Jul");
  assert.equal(formatRoundDeadline(lateJune), "Wed 1 Jul, 00:30");
  // In UTC this instant is still 30 June, which is exactly what must not be
  // printed.
  assert.equal(lateJune.toISOString().slice(0, 10), "2026-06-30");

  // And the real autumn deadline reads back as the wall clock it was set to.
  assert.equal(formatRoundDeadline(CLOSES), "Sun 18 Oct, 23:59");
  // September is the one month whose en-GB abbreviation ICU has changed
  // ("Sep" on older data, "Sept" on newer), so this one is matched rather
  // than compared. The DAY is what the test is about, and the day is exact.
  assert.match(formatRoundDate(OPENS), /^Mon 21 Sept?$/);
});

// ===========================================================================
// §3 STAGE RELEASE: may this question be served
// ===========================================================================

test("a stage with no schedule releases WITH the round, and not before", () => {
  // The single-stage case: this stage IS the form. It must not be readable
  // before the window opens, and it must be readable the moment it does.
  const s = stage();
  assert.equal(isStageReleased(s, round(), BEFORE), false);
  assert.equal(isStageReleased(s, round(), OPENS), true);
  assert.equal(isStageReleased(s, round(), INSIDE), true);
});

test("a draft, archived or cancelled round releases nothing", () => {
  const s = stage();
  assert.equal(isStageReleased(s, round({ status: "draft" }), INSIDE), false);
  assert.equal(isStageReleased(s, round({ archived: true }), INSIDE), false);
  // Cancelling a round is a decision to stop asking. `roundWindowState` calls
  // it "closed" because its question is only "can you apply"; the distinction
  // is drawn in stageRelease, where it matters.
  assert.equal(isStageReleased(s, round({ status: "cancelled" }), INSIDE), false);
  assert.equal(roundWindowState(round({ status: "cancelled" }), INSIDE).state, "closed");
});

test("a closed round keeps its questions released", () => {
  // Reviewers read them all through review week, and an applicant may look
  // back at what they were asked. Closing takes away the form, not the record.
  for (const status of ["closed", "deciding", "settled"]) {
    assert.equal(isStageReleased(stage(), round({ status }), AFTER), true);
  }
  // And a round still open but past its deadline is the same case.
  assert.equal(isStageReleased(stage(), round(), AFTER), true);
});

test("a scheduled stage releases at its instant, inclusively, and not before", () => {
  const s = stage({ releaseAt: "2026-10-05", releaseTimeLocal: "09:00" });
  const at = stageReleaseInstant(s);
  assert.equal(at.toISOString(), "2026-10-05T08:00:00.000Z"); // 09:00 BST
  assert.equal(isStageReleased(s, round(), new Date(at.getTime() - 1)), false);
  assert.equal(isStageReleased(s, round(), at), true);
  assert.equal(isStageReleased(s, round(), new Date(at.getTime() + 1)), true);
});

test("a manual release only ever brings a release FORWARD", () => {
  const scheduled = stage({ releaseAt: "2026-10-12", releaseTimeLocal: "09:00" });
  const pressed = new Date("2026-10-06T15:00:00Z");
  const early = { ...scheduled, manualReleasedAt: pressed };

  // Before the button was pressed: still not released.
  assert.equal(isStageReleased(early, round(), new Date(pressed.getTime() - 1)), false);
  // After: released, six days before the schedule said.
  assert.equal(isStageReleased(early, round(), pressed), true);

  // A manual stamp cannot push a release BACK: once the schedule has passed
  // the stage is out, because a question already served cannot be unserved.
  const late = {
    ...stage({ releaseAt: "2026-10-05", releaseTimeLocal: "09:00" }),
    manualReleasedAt: new Date("2026-12-01T00:00:00Z"),
  };
  assert.equal(isStageReleased(late, round(), new Date("2026-10-06T00:00:00Z")), true);

  // And a manual stamp still cannot outrun the ROUND: a draft round releases
  // nothing however hard the button is pressed.
  assert.equal(isStageReleased(early, round({ status: "draft" }), AFTER), false);
});

test("a malformed release date falls back to releasing with the round", () => {
  // 2026-02-31 does not exist. The alternative to this fallback is a route
  // that 500s on a half-authored round; the readiness panel is what stops a
  // malformed date reaching an OPEN round in the first place.
  assert.equal(stageReleaseInstant(stage({ releaseAt: "2026-02-31" })), null);
  assert.equal(stageReleaseInstant(stage({ releaseAt: "5 October" })), null);
  assert.equal(stageReleaseInstant(stage({ releaseAt: "" })), null);
  assert.equal(isStageReleased(stage({ releaseAt: "2026-02-31" }), round(), OPENS), true);

  // A malformed TIME falls back to the default wall clock rather than to
  // midnight, which would release a question nine hours early.
  const s = stage({ releaseAt: "2026-10-05", releaseTimeLocal: "9am" });
  assert.equal(stageReleaseInstant(s).toISOString(), "2026-10-05T08:00:00.000Z");
});

// ---------------------------------------------------------------------------
// §3.4 THE LONDON DAY BOUNDARY, on the release side
// ---------------------------------------------------------------------------

test("LONDON: the same announced wall clock is a different instant either side of the clock change", () => {
  // British Summer Time ends at 02:00 on Sunday 25 October 2026. A stage
  // announced for "09:00 on Monday" releases at 08:00Z the week before and at
  // 09:00Z the week after. An implementation that stored or derived the
  // instant in UTC would release the second one an hour before it was
  // announced, on the exact week the questions matter most.
  const beforeClocks = stage({ releaseAt: "2026-10-19", releaseTimeLocal: "09:00" });
  const afterClocks = stage({ releaseAt: "2026-10-26", releaseTimeLocal: "09:00" });
  assert.equal(
    stageReleaseInstant(beforeClocks).toISOString(),
    "2026-10-19T08:00:00.000Z",
  );
  assert.equal(
    stageReleaseInstant(afterClocks).toISOString(),
    "2026-10-26T09:00:00.000Z",
  );

  // The hour that would have leaked: 08:00Z on 26 October is 08:00 London,
  // an hour before the announced time, and the stage is NOT released then.
  const openLate = round({ closesAt: null });
  assert.equal(
    isStageReleased(afterClocks, openLate, new Date("2026-10-26T08:00:00Z")),
    false,
  );
  assert.equal(
    isStageReleased(afterClocks, openLate, new Date("2026-10-26T09:00:00Z")),
    true,
  );
});

test("a stage close is clamped to the round's, and never printed later than it", () => {
  // A stage deadline beyond the round's is a date nobody can meet: the submit
  // route stops accepting at the round's close. Printing it would be the
  // discovery-versus-submit disagreement one level down.
  const earlier = new Date("2026-10-11T22:59:00Z");
  const later = new Date("2026-11-01T00:00:00Z");
  assert.equal(effectiveStageClose(stage(), round()), CLOSES);
  assert.equal(effectiveStageClose(stage({ closesAt: earlier }), round()), earlier);
  assert.equal(effectiveStageClose(stage({ closesAt: later }), round()), CLOSES);
  // Unbounded only when the round itself is, which is a readiness-panel
  // failure rather than a state to render.
  assert.equal(effectiveStageClose(stage(), round({ closesAt: null })), null);
  assert.equal(
    effectiveStageClose(stage({ closesAt: earlier }), round({ closesAt: null })),
    earlier,
  );
});

// ===========================================================================
// §4 THE DOCUMENTS: ids, normalisers, and the questions rule
// ===========================================================================

test("the deterministic ids are construct-only and agree with each other", () => {
  assert.equal(admissionApplicationId("autumn__ab12", "u1"), "autumn__ab12__u1");
  // The private row shares the application's id EXACTLY. That is what makes
  // both the destroy cascade and the account-deletion sweep addressed rather
  // than queries, on a document that deliberately has no field to query on.
  assert.equal(
    admissionApplicationPrivateId("autumn__ab12", "u1"),
    admissionApplicationId("autumn__ab12", "u1"),
  );
  assert.equal(
    admissionReviewId("autumn__ab12", "applicant1", "reviewer1"),
    "autumn__ab12__applicant1__reviewer1",
  );
});

test("THE RULE: no round or application document carries a `questions` field", () => {
  // Question text lives ONLY in the stages subcollection, which is
  // `allow read, write: if false`. Any copy of it onto a document a client
  // could read defeats the timed release, and the V2 shape (questions on a
  // signed-in-readable run doc) is exactly how that happened before.
  const roundDoc = normalizeAdmissionRound("r1", {
    questions: [{ id: "q1", type: "longText", label: "Why?", required: true }],
    stageIds: ["s1"],
  });
  assert.equal("questions" in roundDoc, false);
  assert.deepEqual(roundDoc.stageIds, ["s1"]);

  const app = normalizeAdmissionApplication("r1__u1", {
    questions: [{ id: "q1", type: "longText", label: "Why?", required: true }],
  });
  assert.equal("questions" in app, false);

  // The type itself, at the source: a field added later would pass the two
  // assertions above only because no fixture set it.
  const roundType = /export type AdmissionRoundDoc = \{([\s\S]*?)\n\};/.exec(ROUNDS_CODE);
  assert.ok(roundType, "AdmissionRoundDoc is no longer a type literal");
  assert.doesNotMatch(roundType[1], /^\s*questions[?]?:/m);

  // The stage is the ONE place it may live.
  const s = normalizeAdmissionStage("s1", {
    roundId: "r1",
    questions: [{ id: "q1", type: "longText", label: "Why?", required: true }],
  });
  assert.equal(s.questions.length, 1);
  assert.equal(s.questions[0].id, "q1");
});

test("the round status transition table is the contract's, and its terminals are terminal", () => {
  assert.deepEqual(ADMISSION_ROUND_TRANSITIONS.draft, ["open", "cancelled"]);
  assert.deepEqual(ADMISSION_ROUND_TRANSITIONS.open, ["closed", "cancelled"]);
  // `closed -> open` is the extend-the-window path, and it exists on purpose.
  assert.deepEqual(ADMISSION_ROUND_TRANSITIONS.closed, ["deciding", "open"]);
  assert.deepEqual(ADMISSION_ROUND_TRANSITIONS.deciding, ["settled"]);
  assert.deepEqual(ADMISSION_ROUND_TRANSITIONS.settled, []);
  assert.deepEqual(ADMISSION_ROUND_TRANSITIONS.cancelled, []);
  // Exhaustive, so a new status cannot arrive without a row.
  assert.deepEqual(
    Object.keys(ADMISSION_ROUND_TRANSITIONS).sort(),
    [...ADMISSION_ROUND_STATUSES].sort(),
  );
});

test("an unrecognised status normalises to the SAFE end of each union", () => {
  // A round of unknown status is a draft (public to nobody); an application of
  // unknown status is a draft (in no queue, holding no seat). Both are the
  // direction that does the least if the data is wrong.
  assert.equal(normalizeAdmissionRound("r1", { status: "nonsense" }).status, "draft");
  assert.equal(normalizeAdmissionRound("r1", {}).status, "draft");
  assert.equal(
    normalizeAdmissionApplication("r1__u1", { status: "pending" }).status,
    "draft",
  );
  assert.equal(ADMISSION_APPLICATION_STATUSES.includes("pending"), false);
});

test("a review's stored total never beats its stored scores", () => {
  // `total` is recomputed server-side on every write, so a row where the two
  // disagree is one somebody reached around the route to write. The scores win.
  const r = normalizeAdmissionReview("r1__a1__v1", {
    roundId: "r1",
    applicantUid: "a1",
    reviewerUid: "v1",
    scores: { c1: 4, c2: 3 },
    total: 999,
    recommendation: "advance",
    knowsApplicant: true,
  });
  assert.equal(r.total, 7);
  assert.equal(reviewTotal({ c1: 4, c2: 3 }), 7);
  assert.equal(reviewTotal({ c1: 4, c2: "5" }), 4);
  assert.equal(normalizeAdmissionReview("x", { recommendation: "maybe" }).recommendation, null);
});

test("the private row carries the access answer and NOTHING else", () => {
  // The collection's whole design is that no reader can join it by accident,
  // and a second field starts the "which readers have to remember to strip
  // this" problem it exists to end.
  const p = normalizeAdmissionApplicationPrivate("r1__u1", {
    accessRequirements: "I use a wheelchair.",
    uid: "u1",
    roundId: "r1",
    notes: "smuggled",
  });
  assert.deepEqual(Object.keys(p).sort(), ["accessRequirements", "id"]);
  assert.equal(p.accessRequirements, "I use a wheelchair.");
});

test("a reviewer's conduct chip is a boolean and can never carry the reason", () => {
  const flag = normalizeMemberConductFlag("u1", {
    flagged: true,
    reason: "the allegation",
    byUid: "admin1",
    byName: "Admin One",
  });
  assert.equal(flag.reason, "the allegation");
  // What a reviewer payload may include. A `...flag` spread would leak the
  // reason by default, which is why this is a function and not a convention.
  assert.deepEqual(conductChip(flag), { flagged: true });
  assert.deepEqual(conductChip(null), { flagged: false });
});

// ===========================================================================
// §5 THE ACCOUNT-DELETION SWEEP
//
// `accountDeletion.ts` is `import "server-only"` and drives firebase-admin, so
// it cannot be executed here. These are MODEL pins in the
// `course-deletion.test.mjs` idiom: the rule reproduced and asserted at the
// source. If a pin fails, the code has drifted from the rule; do not fix it by
// loosening the pin.
// ===========================================================================

test("MODEL: the summary counts every admissions collection the sweep touches", () => {
  const summaryType = /export type AccountDeletionSummary = \{([\s\S]*?)\n\};/.exec(
    ACCOUNT_DELETION,
  );
  assert.ok(summaryType, "AccountDeletionSummary is no longer a type literal");
  const declared = [...summaryType[1].matchAll(/^ {2}(\w+)(\??):/gm)].map((m) => [
    m[1],
    m[2] === "?",
  ]);
  const names = declared.map(([name]) => name);
  for (const key of [
    "admissionApplicationsDeleted",
    "admissionApplicationPrivateDeleted",
    "admissionReviewsDeleted",
    "admissionReviewsAuthoredDeleted",
    "conductFlagDeleted",
  ]) {
    assert.ok(names.includes(key), `the summary does not report ${key}`);
  }
  // And every REQUIRED key is initialised, so a collection the sweep failed
  // on reports 0 rather than `undefined` in a 207 body. `warning` is the one
  // optional member and is absent on a clean teardown by design.
  for (const [key, optional] of declared) {
    if (optional) continue;
    assert.match(
      ACCOUNT_DELETION,
      new RegExp(`^\\s*${key}: (0|false),`, "m"),
      `${key} is declared but never initialised in the summary literal`,
    );
  }
  assert.deepEqual(
    declared.filter(([, optional]) => optional).map(([name]) => name),
    ["warning"],
  );
});

test("MODEL: the access-requirements row dies in the SAME BATCH as its application", () => {
  // It has no field to query on by design, so the application id is the only
  // handle back to it. A separate sweep running afterwards would find nothing
  // to address and would strand disability and health information in a
  // deny-everything collection nothing on the site could name.
  const fn = ACCOUNT_DELETION.slice(
    ACCOUNT_DELETION.indexOf("async function deleteAdmissionApplications"),
    ACCOUNT_DELETION.indexOf("Cascade-delete an account by uid"),
  );
  assert.ok(fn.length > 0, "deleteAdmissionApplications is gone");

  const batchAt = fn.indexOf("const batch = db.batch();");
  const privateDeleteAt = fn.indexOf("for (const d of livePrivate) batch.delete(d.ref);");
  const appDeleteAt = fn.indexOf("for (const d of snap.docs) batch.delete(d.ref);");
  const commitAt = fn.indexOf("await batch.commit();");
  assert.ok(batchAt !== -1 && commitAt !== -1, "the page is no longer written as one batch");
  assert.ok(
    batchAt < privateDeleteAt && privateDeleteAt < commitAt,
    "the private rows are not deleted inside the application batch",
  );
  assert.ok(
    batchAt < appDeleteAt && appDeleteAt < commitAt,
    "the applications are not deleted inside the same batch",
  );
  // No second, separate sweep of the private collection: that is the shape
  // this design exists to avoid.
  assert.doesNotMatch(
    ACCOUNT_DELETION_CODE,
    /deleteOwnedCourseRows\(\s*db,\s*"admissionApplicationPrivate"/,
    "admissionApplicationPrivate is being swept separately from its applications",
  );
});

test("MODEL: reviews are swept from BOTH sides, and the conduct flag is addressed", () => {
  // The applicant side and the reviewer side name the same account through
  // two different fields, so one sweep would leave the other half behind.
  assert.match(ACCOUNT_DELETION_CODE, /"admissionReviews",\s*uid,\s*"applicantUid"/);
  assert.match(ACCOUNT_DELETION_CODE, /"admissionReviews",\s*uid,\s*"reviewerUid"/);
  // The retention decision for reviewer-authored rows is DELETE, and it is
  // argued at the call site rather than left silent.
  assert.match(ACCOUNT_DELETION, /RETENTION DECISION/);
  // One flag per member, so no query and no index.
  assert.match(
    ACCOUNT_DELETION_CODE,
    /collection\("memberConductFlags"\)\.doc\(uid\)/,
  );
});

test("MODEL: every admissions step is best-effort and none can abort the cascade", () => {
  // The one FATAL step is the subscription rows, because a surviving row keeps
  // mailing a deleted user. Nothing in admissions has that property, and a
  // throw from any of it would cost the caller the Auth deletion.
  // Ends at the membership sweep, which is the next step after admissions and
  // is not one: counting its try as an admissions collection would let a
  // future admissions step go missing without this failing.
  const block = ACCOUNT_DELETION.slice(
    ACCOUNT_DELETION.indexOf("// 5d. ADMISSIONS"),
    ACCOUNT_DELETION.indexOf("// 5e. MEMBERSHIP"),
  );
  assert.ok(block.length > 0, "the admissions block moved or lost its marker comment");
  // Four collections the account OWNS rows in, plus the rounds that merely
  // NAME it: reviewer lists and final decider, cleared by the same rule.
  assert.equal((block.match(/\btry \{/g) ?? []).length, 5, "one try per collection");
  assert.equal((block.match(/partialFailure = true;/g) ?? []).length, 5);
  assert.match(block, /clearAdmissionRoundRoles\(db, uid\)/);
  assert.doesNotMatch(block, /\bthrow\b/);
});
