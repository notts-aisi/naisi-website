/**
 * Unit tests for GROUP-FIRST RESOLUTION — `src/lib/courses/groupResolve.ts`,
 * the ONE shared helper of v2 decision 4's copy-on-write, plus the four new
 * group-autonomy routes' source-level properties.
 *
 * THE DESIGN RULE UNDER TEST: a member's week content = their group's forked
 * week if it exists, else the run canonical; a member's calendar = their
 * group's overrides if set, else the run's. Every consumer resolves through
 * this module — so this suite pins the fallback in BOTH directions (content
 * and calendar), the DST behaviour of a group-paced calendar (the week-plan
 * suite's precedent), and the divergence predicate the allocation board
 * discloses moves with.
 *
 * Route handlers cannot be imported (`next/server`, `firebase-admin`), so
 * route-level properties — the fork route's id-preserving copy, the PATCH's
 * server-enforced trust boundary and in-transaction delete-warning counts,
 * the pace route's strand gate, the notice route's decision-8 lane — are
 * asserted at the SOURCE, exactly as `course-schedule-changes.test.mjs` does.
 * The `resolveWeek*` server helpers ARE importable (their firebase-admin
 * import is type-only) and are exercised against a hand-rolled fake db.
 *
 * ## The loader dance
 *
 * Lifted from `course-schedule-changes.test.mjs` / `course-nudge.test.mjs`.
 * Same rules: nothing in `STUBS` is reachable from an assertion here.
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
        "the `typescript` devDependency is not installed — run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const {
  groupsDiverge,
  memberCurrentWeek,
  resolveCalendar,
  resolveGroupCalendar,
  resolveGroupCalendars,
  resolveWeekDoc,
  resolveWeekDocs,
  resolveWeekRef,
} = await loadTs("lib/courses/groupResolve.ts");
const { ownAttendanceSessions, sessionsFromJoinWeek } = await loadTs(
  "lib/courses/ownAttendance.ts",
);
const { addDaysToKey, currentWeekFor } = await loadTs("lib/courses/weekPlan.ts");
const { normalizeCourseWeek, weekDocId } = await loadTs("lib/firestore/courses.ts");
const {
  normalizeCourseGroup,
  normalizeGroupWeek,
  sessionForWeek,
  sessionModeForWeek,
} = await loadTs("lib/firestore/courseGroups.ts");
const { templateWeekFields } = await loadTs("lib/firestore/courseTemplates.ts");

// ---------------------------------------------------------------------------
// Source handles — route properties are asserted at the source (see header).
// ---------------------------------------------------------------------------

const src = (...parts) => readFileSync(join(SRC, ...parts), "utf8");
const api = (...parts) => src("app", "api", "courses", ...parts);

const OVERVIEW = api("runs", "[runId]", "overview", "route.ts");
const FORK = api("groups", "[groupId]", "weeks", "[weekId]", "fork", "route.ts");
const WEEK_PATCH = api("groups", "[groupId]", "weeks", "[weekId]", "route.ts");
const PACE = api("groups", "[groupId]", "pace", "route.ts");
const NOTICE = api("groups", "[groupId]", "notice", "route.ts");
const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Monday, so every slot below starts on a Monday. */
const START = "2026-09-28";

const week = (n) => ({ kind: "week", weekNumber: n, weekId: weekDocId(n) });
const brk = (label) => ({ kind: "break", label });
const plainPlan = (n) => Array.from({ length: n }, (_, i) => week(i + 1));

const run = (overrides = {}) => ({
  startDate: START,
  weekPlan: plainPlan(8),
  ...overrides,
});

/** A group's pace-override shape. Defaults to TRACKING the run. */
const pace = (overrides = {}) => ({
  paceStartDate: null,
  paceWeekPlan: null,
  ...overrides,
});

/** Noon on the `d`th day after `startDate`. */
function dayOf(d, startDate = START) {
  return new Date(`${addDaysToKey(startDate, d)}T12:00:00Z`);
}

/**
 * A fake Firestore: `store` maps slash paths to data objects; every read is
 * recorded so a test can assert which copies were consulted. Just enough of
 * the surface the resolver touches — doc().get(), collection().get().
 */
function makeDb(store, reads = []) {
  const list = (prefix) =>
    Object.keys(store)
      .filter(
        (k) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"),
      )
      .sort()
      .map((k) => ({ id: k.split("/").pop(), data: () => store[k] }));
  const makeDocRef = (path) => ({
    id: path.split("/").pop(),
    get: async () => {
      reads.push(path);
      return {
        exists: Object.hasOwn(store, path),
        id: path.split("/").pop(),
        ref: makeDocRef(path),
        data: () => store[path] ?? {},
      };
    },
    collection: (name) => makeCollection(`${path}/${name}`),
  });
  const makeCollection = (path) => ({
    doc: (id) => makeDocRef(`${path}/${id}`),
    get: async () => {
      reads.push(`${path}/*`);
      return { docs: list(path) };
    },
  });
  return { collection: (name) => makeCollection(name) };
}

const CANONICAL_W3 = {
  weekNumber: 3,
  title: "Goal misgeneralisation",
  summary: "The canonical take.",
  guideBlocks: [],
  materials: [{ id: "m1", type: "reading", title: "Ngo et al.", url: "https://example.com/p" }],
  exercises: [{ id: "x1", prompt: "Why?", responseType: "text", required: false, maxLength: 2000, peerVisible: false }],
  checklist: [{ id: "c1", title: "Read the paper", mirrorToMyWork: true }],
  estimatedMinutes: 90,
  published: true,
};

const FORKED_W3 = {
  ...CANONICAL_W3,
  title: "Goal misgeneralisation (our group's cut)",
  forkedAt: new Date("2026-10-01T10:00:00Z"),
  forkedByUid: "facil",
  forkedFromRunWeekAt: null,
};

// ===========================================================================
// resolveCalendar — the calendar fallback, both directions
// ===========================================================================

test("GUARD — no group, or a group tracking the run, resolves the run's calendar", () => {
  for (const group of [null, pace()]) {
    const cal = resolveCalendar(run(), group);
    assert.equal(cal.source, "run");
    assert.equal(cal.startDate, START);
    assert.equal(cal.weekPlan.length, 8);
  }
});

test("GUARD — overrides apply PER FIELD, and either one flips source to group", () => {
  const dated = resolveCalendar(run(), pace({ paceStartDate: "2026-10-12" }));
  assert.deepEqual(
    { startDate: dated.startDate, planLength: dated.weekPlan.length, source: dated.source },
    { startDate: "2026-10-12", planLength: 8, source: "group" },
  );

  const planned = resolveCalendar(run(), pace({ paceWeekPlan: plainPlan(6) }));
  assert.deepEqual(
    { startDate: planned.startDate, planLength: planned.weekPlan.length, source: planned.source },
    { startDate: START, planLength: 6, source: "group" },
  );

  const both = resolveCalendar(
    run(),
    pace({ paceStartDate: "2026-10-12", paceWeekPlan: plainPlan(6) }),
  );
  assert.equal(both.startDate, "2026-10-12");
  assert.equal(both.weekPlan.length, 6);
  assert.equal(both.source, "group");
});

test("GUARD — memberCurrentWeek paces a group behind AND ahead of its run", () => {
  const now = dayOf(30); // the run's cohort is on week 5
  assert.equal(currentWeekFor(run(), now).weekNumber, 5);

  // Two weeks BEHIND (started later): the member is on week 3.
  const behind = memberCurrentWeek(run(), pace({ paceStartDate: addDaysToKey(START, 14) }), now);
  assert.equal(behind.weekNumber, 3);

  // One week AHEAD (started earlier): the member is on week 6.
  const ahead = memberCurrentWeek(run(), pace({ paceStartDate: addDaysToKey(START, -7) }), now);
  assert.equal(ahead.weekNumber, 6);

  // And a group-shaped PLAN moves the member onto the group's own break while
  // the run's cohort is mid-week — the calendar fallback in the plan lane.
  // Day 16 sits in slot 2, which the group's plan makes a break (the run's
  // cohort is on week 3 that day).
  const grpPlan = [week(1), week(2), brk("Our reading week"), ...plainPlan(8).slice(2)];
  const breakDay = dayOf(16);
  assert.equal(currentWeekFor(run(), breakDay).weekNumber, 3);
  const onBreak = memberCurrentWeek(run(), pace({ paceWeekPlan: grpPlan }), breakDay);
  assert.equal(onBreak.weekNumber, null);
  assert.equal(onBreak.breakLabel, "Our reading week");
  assert.equal(onBreak.anchorWeekNumber, 2);
});

test("GUARD — a group-paced week still rolls at LONDON civil midnight across both clock changes", () => {
  // The week-plan suite's DST precedent, replayed through the resolver: the
  // group's own pace must inherit the civil-date arithmetic, not re-derive an
  // elapsed-milliseconds version of it.
  //
  // BST -> GMT, Sun 25 Oct 2026. Group week 1 runs Mon 19 Oct – Sun 25 Oct —
  // a 169-hour week. 23:30Z on the 25th is 23:30 GMT London: STILL week 1.
  // (A naive (now - start)/86400000 against the BST start instant reads 7.02
  // days here and rolls a week early.)
  const autumn = pace({ paceStartDate: "2026-10-19" });
  assert.equal(
    memberCurrentWeek(run(), autumn, new Date("2026-10-25T23:30:00Z")).planIndex,
    0,
  );
  assert.equal(
    memberCurrentWeek(run(), autumn, new Date("2026-10-26T00:30:00Z")).planIndex,
    1,
  );

  // GMT -> BST, Sun 28 Mar 2027. Group week 1 runs Mon 22 Mar – Sun 28 Mar —
  // a 167-hour week. 23:30Z on the 28th is already 00:30 BST on the 29th in
  // London: week 2 has begun (the naive version rolls an hour late).
  const spring = pace({ paceStartDate: "2027-03-22" });
  assert.equal(
    memberCurrentWeek(run(), spring, new Date("2027-03-28T22:30:00Z")).planIndex,
    0,
  );
  assert.equal(
    memberCurrentWeek(run(), spring, new Date("2027-03-28T23:30:00Z")).planIndex,
    1,
  );
});

test("GUARD — a garbled stored pace date normalises to TRACKING, never to a garbage week", () => {
  // normalizeCourseGroup + resolveCalendar compose to the safe degradation:
  // an impossible date (right shape, not a day) nulls out, so the member
  // falls back to the run's calendar instead of a RangeError or a wrong week.
  const group = normalizeCourseGroup("g1", {
    runId: "run1",
    name: "Group A",
    paceStartDate: "2026-02-31",
    paceWeekPlan: "not-a-plan",
  });
  assert.equal(group.paceStartDate, null);
  assert.equal(group.paceWeekPlan, null);
  assert.equal(resolveCalendar(run(), group).source, "run");
});

// ===========================================================================
// resolveWeek* — the content fallback, both directions, against a fake db
// ===========================================================================

const CONTENT_STORE = {
  "courseRuns/run1/weeks/w03": CANONICAL_W3,
  "courseRuns/run1/weeks/w04": { ...CANONICAL_W3, weekNumber: 4, title: "Week four" },
  "courseGroups/g1/weeks/w03": FORKED_W3,
  // An ORPHAN fork: canonical w09 has been deleted, the group's copy remains.
  "courseGroups/g1/weeks/w09": { ...FORKED_W3, weekNumber: 9, title: "Our extra week" },
};

test("GUARD — a forked week resolves the GROUP copy, an unforked week the canonical", async () => {
  const db = makeDb(CONTENT_STORE);

  const forked = await resolveWeekDoc(db, "run1", "g1", "w03");
  assert.equal(forked.source, "group");
  assert.equal(forked.week.title, "Goal misgeneralisation (our group's cut)");
  // The fork keeps the canonical's item ids — the invariant progress hangs on.
  assert.deepEqual(forked.week.materials.map((m) => m.id), ["m1"]);

  const unforked = await resolveWeekDoc(db, "run1", "g1", "w04");
  assert.equal(unforked.source, "run");
  assert.equal(unforked.week.title, "Week four");

  // Neither copy exists: the wrapper is NON-NULL with week: null — consumers
  // destructure `const { week } = await resolveWeekDoc(...)` without a check.
  const missing = await resolveWeekDoc(db, "run1", "g1", "w05");
  assert.deepEqual(missing, { source: "run", week: null });
});

test("GUARD — an unallocated member (groupId null) never touches the group collection", async () => {
  const reads = [];
  const db = makeDb(CONTENT_STORE, reads);
  const resolved = await resolveWeekDoc(db, "run1", null, "w03");
  assert.equal(resolved.source, "run");
  assert.equal(resolved.week.title, "Goal misgeneralisation");
  assert.equal(reads.some((path) => path.startsWith("courseGroups")), false);
});

test("GUARD — resolveWeekDocs overlays forks by id, keeps orphan forks, sorts by id", async () => {
  const db = makeDb(CONTENT_STORE);
  const weeks = await resolveWeekDocs(db, "run1", "g1");
  assert.deepEqual(
    weeks.map((w) => [w.week.id, w.source]),
    [
      ["w03", "group"], // the fork shadows canonical w03
      ["w04", "run"],
      ["w09", "group"], // the orphan fork survives — its members' truth
    ],
  );
  // And without a group, the same call is the canonical listing.
  const canonical = await resolveWeekDocs(db, "run1", null);
  assert.deepEqual(canonical.map((w) => [w.week.id, w.source]), [
    ["w03", "run"],
    ["w04", "run"],
  ]);
});

test("GUARD — resolveWeekRef points where a read would land, fork-first", async () => {
  const db = makeDb(CONTENT_STORE);
  const forked = await resolveWeekRef(db, "run1", "g1", "w03");
  assert.equal(forked.source, "group");
  assert.equal(forked.ref.id, "w03");
  const unforked = await resolveWeekRef(db, "run1", "g1", "w04");
  assert.equal(unforked.source, "run");
  const ungrouped = await resolveWeekRef(db, "run1", null, "w03");
  assert.equal(ungrouped.source, "run");
});

// ===========================================================================
// groupsDiverge — the allocation board's disclosure predicate
// ===========================================================================

const clean = (overrides = {}) => ({
  forkedWeekIds: [],
  paceStartDate: null,
  paceWeekPlan: null,
  ...overrides,
});

const NO_DIVERGENCE = { pace: false, content: false };

test("GUARD — two clean groups on the run's clock do not diverge, and null IS the run canonical", () => {
  assert.deepEqual(groupsDiverge(clean(), clean()), NO_DIVERGENCE);
  // `null` = the unallocated pool / run canonical — the board passes it for
  // the "no group" column, and it must equal a clean tracking group.
  assert.deepEqual(groupsDiverge(null, null), NO_DIVERGENCE);
  assert.deepEqual(groupsDiverge(null, clean()), NO_DIVERGENCE);
  // Same overrides on both sides is also NO divergence — the move crosses no
  // boundary when both rooms run the identical off-run calendar.
  assert.deepEqual(
    groupsDiverge(
      clean({ paceStartDate: "2026-10-12", paceWeekPlan: plainPlan(6) }),
      clean({ paceStartDate: "2026-10-12", paceWeekPlan: plainPlan(6) }),
    ),
    NO_DIVERGENCE,
  );
});

test("GUARD — any pace difference flags the PACE lane, compared DEEP and as overrides", () => {
  // Two lanes, never a collapsed boolean: the board words each separately,
  // and `course-schedule-changes.test.mjs` pins the same contract.
  assert.deepEqual(
    groupsDiverge(clean({ paceStartDate: "2026-10-12" }), clean()),
    { pace: true, content: false },
  );
  assert.equal(
    groupsDiverge(clean({ paceWeekPlan: plainPlan(6) }), clean({ paceWeekPlan: plainPlan(7) })).pace,
    true,
  );
  // Same length, one entry differs — the deep compare, not a length check.
  const a = [...plainPlan(3), brk("Reading week")];
  const b = [...plainPlan(3), brk("Exam week")];
  assert.equal(groupsDiverge(clean({ paceWeekPlan: a }), clean({ paceWeekPlan: b })).pace, true);
  // Overrides compare AS overrides: a pace equal to the run's own start still
  // diverges from tracking — the group has left the run's clock, and that is
  // the operational fact the board discloses. Conservative by design.
  assert.equal(groupsDiverge(clean({ paceStartDate: START }), null).pace, true);
});

test("GUARD — ANY fork on either side flags the CONTENT lane — equal fork sets included", () => {
  assert.deepEqual(
    groupsDiverge(clean({ forkedWeekIds: ["w03"] }), clean()),
    { pace: false, content: true },
  );
  assert.equal(groupsDiverge(null, clean({ forkedWeekIds: ["w03"] })).content, true);
  // Both forked the SAME week: two independent copies with independent edits.
  // Equal id sets prove nothing and the predicate does not read week bodies,
  // so this is divergence — the documented conservative direction.
  assert.equal(
    groupsDiverge(clean({ forkedWeekIds: ["w03"] }), clean({ forkedWeekIds: ["w03"] })).content,
    true,
  );
});

// ===========================================================================
// The group-week normaliser and the session mode reader
// ===========================================================================

test("GUARD — the fork round-trip preserves every id (the V2-2 fixpoint, one hop further)", () => {
  // The fork route writes `templateWeekFields(normalizeCourseWeek(...))` plus
  // the fork stamp; `normalizeGroupWeek` reads it back. Ids must survive the
  // whole loop or progress/response keys orphan the moment a group forks.
  const canonical = normalizeCourseWeek("w03", CANONICAL_W3);
  const stored = {
    ...templateWeekFields(canonical),
    forkedAt: new Date("2026-10-01T10:00:00Z"),
    forkedByUid: "facil",
    forkedFromRunWeekAt: null,
  };
  const fork = normalizeGroupWeek("w03", stored);
  assert.equal(fork.id, "w03");
  assert.equal(fork.weekNumber, 3);
  assert.deepEqual(fork.materials.map((m) => m.id), canonical.materials.map((m) => m.id));
  assert.deepEqual(fork.exercises.map((x) => x.id), canonical.exercises.map((x) => x.id));
  assert.deepEqual(fork.checklist.map((c) => c.id), canonical.checklist.map((c) => c.id));
  assert.equal(fork.forkedByUid, "facil");
  assert.ok(fork.forkedAt instanceof Date);
  assert.equal(fork.forkedFromRunWeekAt, null);
  // And a second hop is a fixpoint: normalising the same fields again changes
  // nothing — the templateWeekFields contract, extended to the fork shape.
  const again = normalizeGroupWeek("w03", {
    ...templateWeekFields(fork),
    forkedAt: stored.forkedAt,
    forkedByUid: stored.forkedByUid,
    forkedFromRunWeekAt: null,
  });
  assert.deepEqual(again.materials, fork.materials);
  assert.deepEqual(again.exercises, fork.exercises);
  assert.deepEqual(again.checklist, fork.checklist);
});

test("GUARD — sessionModes folds into the resolved overrides; a smuggled mode is DEAD DATA", () => {
  // Storage vs resolved shape (see GroupSessionMode in courseGroups.ts): the
  // modes live in the server-owned flat `sessionModes` map, and normalise
  // folds them into `sessionOverrides[weekId].mode` — the one shape every
  // consumer reads.
  const group = normalizeCourseGroup("g1", {
    runId: "run1",
    name: "Group A",
    sessionModes: {
      w03: "virtual",
      w04: "hybrid", // not a mode — dropped
      w06: "in-person", // no override entry for w06 — folding CREATES one
      zz: "virtual", // not an addressable week id — dropped
    },
    sessionOverrides: {
      w03: { location: "Online" },
      w04: { location: "B52" },
      // THE TRUST BOUNDARY HALF THE RULES CANNOT HOLD: a client CAN write a
      // `mode` key inside an override value (pinning a nested field across an
      // arbitrary-keyed map blew the rules expression budget — see the rules
      // comment), so the normaliser must never read it. Dead data, by proof:
      w05: { mode: "virtual", location: "B52" },
    },
  });
  assert.equal(group.sessionOverrides.w03.mode, "virtual");
  assert.equal("mode" in group.sessionOverrides.w04, false);
  assert.equal(group.sessionOverrides.w06.mode, "in-person");
  assert.equal("zz" in group.sessionOverrides, false);
  // The smuggled one did not survive.
  assert.equal("mode" in group.sessionOverrides.w05, false);

  // The mode has its OWN reader; the merged session STRIPS it, so every
  // existing sessionForWeek consumer keeps its exact shape.
  assert.equal(sessionModeForWeek(group, "w03"), "virtual");
  assert.equal(sessionModeForWeek(group, "w04"), null);
  assert.equal(sessionModeForWeek(group, "w05"), null);
  assert.equal(sessionModeForWeek(group, "w06"), "in-person");
  const merged = sessionForWeek(group, "w03");
  assert.equal("mode" in merged, false);
  assert.equal(merged.location, "Online");
});

// ===========================================================================
// Route source guards — the schedule-changes idiom (routes are unimportable)
// ===========================================================================

test("GUARD — the fork route copies through templateWeekFields and mints NOTHING", () => {
  // Id preservation is the platform invariant (V2-2): the copy goes through
  // the one shared field carrier, under the canonical snapshot's own doc id.
  assert.match(FORK, /templateWeekFields\(canonical\)/);
  assert.doesNotMatch(FORK, /newMaterialId|newExerciseId|newChecklistItemId/);
  assert.doesNotMatch(FORK, /weekDocId\(/);
  // Idempotent via create(): ALREADY_EXISTS is ok:true, alreadyForked:true —
  // never an overwrite of an existing fork's edits.
  assert.match(FORK, /\.create\(\{/);
  assert.match(FORK, /isAlreadyExists\(err\)/);
  assert.match(FORK, /alreadyForked: true/);
  // Facilitator-of-THIS-live-group ∪ admin, authorization before existence.
  assert.match(FORK, /group && !group\.archived && group\.facilitatorUids\.includes\(actor\.uid\)/);
});

test("GUARD — the week PATCH enforces the trust boundary SERVER-SIDE and refuses unforked", () => {
  // Decision 5: guideBlocks never accepted from facilitators — refused before
  // field validation, as a 403, on the key's PRESENCE.
  assert.match(WEEK_PATCH, /if \("guideBlocks" in body && !trusted\)/);
  assert.match(WEEK_PATCH, /Guide content is authored by admins and track leads\./);
  // Copy-on-write: editing an unforked week is a 409 with the fork hint —
  // two explicit steps, no auto-fork-on-save.
  assert.match(WEEK_PATCH, /needsFork: true/);
  // The closed field set: title and weekNumber are accepted from NOBODY.
  const allowed = /const ALLOWED_KEYS = new Set\(\[[\s\S]*?\]\);/.exec(WEEK_PATCH)[0];
  for (const key of ["summary", "estimatedMinutes", "published", "materials", "exercises", "checklist", "guideBlocks", "acknowledgeOrphans"]) {
    assert.ok(allowed.includes(`"${key}"`), `ALLOWED_KEYS lost ${key}`);
  }
  assert.equal(allowed.includes('"title"'), false);
  assert.equal(allowed.includes('"weekNumber"'), false);
  // Links go through the exercise-submit machinery.
  assert.match(WEEK_PATCH, /validateSubmissionUrl\(m\.url, LIMITS\.materialUrl\)/);
});

test("GUARD — the PATCH's delete-warning counts run INSIDE the write transaction", () => {
  // The V2-2 apply-template precedent, cited by the route: courseProgress is
  // a client-direct write, so the count and the week write must be one
  // serialisable unit — tx.get(aggregate), then the update, same callback.
  assert.match(WEEK_PATCH, /db\.runTransaction/);
  assert.match(WEEK_PATCH, /await tx\.get\(\s*db\s*\.collection\("courseProgress"\)/);
  assert.match(WEEK_PATCH, /await tx\.get\(\s*db\s*\.collection\("courseExerciseResponses"\)/);
  assert.match(WEEK_PATCH, /\.count\(\)/);
  assert.match(WEEK_PATCH, /apply-template precedent/);
  // Refusal carries the per-item numbers; acknowledgeOrphans is the override.
  assert.match(WEEK_PATCH, /needsAcknowledge: true, orphans: orphaning/);
  assert.match(WEEK_PATCH, /acknowledgeOrphans = body\.acknowledgeOrphans === true/);
  // The write is the fork ref and nothing else — the canonical is untouched.
  assert.match(WEEK_PATCH, /tx\.update\(forkRef,/);
  assert.doesNotMatch(WEEK_PATCH, /runWeekRef\(/);
});

test("GUARD — the pace route reuses the run's sanitisers and refuses to strand a marked register", () => {
  // The pinned contract: sanitizeWeekPlan + isValidDateKey, then the strand
  // gate — a taught week with marks cannot vanish from the group's plan
  // (decided: REFUSE, for everyone; only NEWLY stranded weeks refuse).
  assert.match(PACE, /sanitizeWeekPlan/);
  assert.match(PACE, /isValidDateKey\(body\.paceStartDate\)/);
  assert.match(PACE, /strandedWeeks: stranded/);
  assert.match(PACE, /already orphaned/);
  // Old and new effective calendars both come from THE resolver.
  assert.match(PACE, /resolveCalendar\(run, fresh\)/);
  assert.match(PACE, /resolveCalendar\(run, nextPace\)/);
  // One transaction: group + run + registers read, then the group write.
  assert.match(PACE, /db\.runTransaction/);
  assert.match(PACE, /tx\.update\(groupRef, update\)/);
  // Clearing stores REAL nulls (the rules pin's null-default contract).
  assert.match(PACE, /if \(hasStart\) update\.paceStartDate = nextStart;/);
});

test("GUARD — the notice route is the decision-8 operational lane: no opt-out, suppression only", () => {
  assert.match(NOTICE, /DECISION 8/);
  // Operational: NO subscription check, NO courses-category check, NO
  // unsubscribe affordance in the outgoing mail — and suppression always
  // honoured. (The words appear in the header's argument; the CODE must not
  // consult any of these.)
  assert.doesNotMatch(NOTICE, /hasOptedOutOfCourseAnnouncements/);
  assert.doesNotMatch(NOTICE, /notifications\.|categories\./);
  assert.doesNotMatch(NOTICE, /listUnsubscribe|unsubscribeUrl/);
  assert.match(NOTICE, /filterSuppressed/);
  // Its own durable counter: 10/day keyed by GROUP (no uid in the key), a
  // SEPARATE prefix from the email route's (sender, group) hourly budget.
  assert.match(NOTICE, /key: `groupnotice__\$\{groupId\}`/);
  assert.match(NOTICE, /NOTICES_PER_WINDOW = 10/);
  assert.match(NOTICE, /24 \* 60 \* 60 \* 1000/);
  // Audited in emailSends under the pinned kind, one message per recipient.
  assert.match(NOTICE, /"course-notice"/);
  assert.match(NOTICE, /to: recipient\.address/);
  assert.match(NOTICE, /dispatchSends\(deliverable/);
  // Subject is SYNTHESISED — request text never reaches a header.
  assert.match(NOTICE, /const subject = `Session update — \$\{group\.name\}`/);
});

test("GUARD — the session route is the mode's only pen, and clears by DELETION", () => {
  const SESSION = api("groups", "[groupId]", "session", "route.ts");
  // The pace route's twin gate, same 403 ordering.
  assert.match(SESSION, /group && !group\.archived && group\.facilitatorUids\.includes\(actor\.uid\)/);
  // Closed body, enum-checked mode, week-id shape.
  assert.match(SESSION, /key !== "weekId" && key !== "mode"/);
  assert.match(SESSION, /GROUP_SESSION_MODES\.includes\(body\.mode/);
  // Writes ONE `sessionModes` entry via FieldPath; null clears by DELETE so
  // "never set" stays absent (sessionModeForWeek reports the difference).
  assert.match(SESSION, /new FieldPath\("sessionModes", weekId\)/);
  assert.match(SESSION, /mode \?\? FieldValue\.delete\(\)/);
  // And it never touches the facilitator-editable overrides map (the header
  // may NAME it; the write path may not).
  assert.doesNotMatch(SESSION, /FieldPath\("sessionOverrides"/);
  assert.doesNotMatch(SESSION, /sessionOverrides:/);
});

test("GUARD — the rules lock group-week forks and pin the pace/mode fields", () => {
  // The fork subcollection: signed-in read, zero client writes.
  const forkBlock = /the group's copy-on-write forks[\s\S]{0,900}?match \/weeks\/\{weekId\} \{\s*allow read: if isSignedIn\(\);\s*allow write: if false;\s*\}/;
  assert.match(RULES, forkBlock);
  // The group-doc pins, null-defaulted (real-null storage contract).
  assert.match(RULES, /request\.resource\.data\.get\('paceStartDate', null\)\s*== resource\.data\.get\('paceStartDate', null\)/);
  assert.match(RULES, /request\.resource\.data\.get\('paceWeekPlan', null\)\s*== resource\.data\.get\('paceWeekPlan', null\)/);
  // The mode pin is ONE whole-map comparison on `sessionModes` — never a
  // per-key walk of sessionOverrides, which blew the rules engine's
  // 1000-expression evaluation budget and denied every legitimate group
  // write (the rules comment records the incident).
  assert.match(RULES, /request\.resource\.data\.get\('sessionModes', \{\}\)\s*== resource\.data\.get\('sessionModes', \{\}\)/);
  assert.match(RULES, /1000-expression/);
  assert.doesNotMatch(RULES, /ovMode\(/);
  // The birth pins: a group is created with none of the server-owned trio.
  assert.match(RULES, /request\.resource\.data\.get\('sessionModes', \{\}\)\.size\(\) == 0/);
});

// ---------------------------------------------------------------------------
// resolveGroupCalendar / resolveGroupCalendars (PR26)
//
// THE BUG THESE PIN: the overview route resolved ONE calendar for the caller
// and drew a card per group off it, so a facilitator holding two groups on
// different pacing was shown the same week number and the same dates twice.
// The unit of resolution is a GROUP, not a caller.
// ---------------------------------------------------------------------------

test("GUARD: two groups on different pacing resolve two different current weeks", () => {
  const now = dayOf(30); // the run's own cohort is on week 5
  const monday = pace(); // tracks the run
  const thursday = pace({ paceStartDate: addDaysToKey(START, 14) }); // 2 weeks behind

  const a = resolveGroupCalendar(run(), monday, now);
  const b = resolveGroupCalendar(run(), thursday, now);

  assert.equal(a.currentWeek.weekNumber, 5);
  assert.equal(b.currentWeek.weekNumber, 3);
  assert.notEqual(a.currentWeek.weekNumber, b.currentWeek.weekNumber);
  // And two different date ranges: each card's dates are built from its own
  // resolved start, which is the whole point of resolving per group.
  assert.equal(a.calendar.startDate, START);
  assert.equal(b.calendar.startDate, addDaysToKey(START, 14));
  assert.equal(a.calendar.source, "run");
  assert.equal(b.calendar.source, "group");

  // An offset that is NOT a whole number of weeks moves the slot boundary too,
  // so the two groups disagree about when the current week even began. (Two
  // groups exactly two weeks apart share slot boundaries and differ only in
  // week number, which is why that is asserted separately above.)
  const midweek = resolveGroupCalendar(
    run(),
    pace({ paceStartDate: addDaysToKey(START, 3) }),
    now,
  );
  assert.notEqual(midweek.currentWeek.slotStartKey, a.currentWeek.slotStartKey);
});

test("GUARD: a group's own PLAN changes its own totalWeeks, not the run's", () => {
  const now = dayOf(30);
  const full = resolveGroupCalendar(run(), pace(), now);
  const short = resolveGroupCalendar(run(), pace({ paceWeekPlan: plainPlan(6) }), now);

  assert.equal(full.totalWeeks, 8);
  assert.equal(short.totalWeeks, 6);
  // Breaks are excluded from the count, exactly as the payload's `totalWeeks`
  // has always been: a reading week is not a taught week.
  const withBreak = resolveGroupCalendar(
    run(),
    pace({ paceWeekPlan: [week(1), brk("Reading week"), week(2)] }),
    now,
  );
  assert.equal(withBreak.totalWeeks, 2);
});

test("GUARD: an unusable start date yields a NULL week, never a throw", () => {
  // `currentWeekFor` throws a RangeError by contract; a summary a page renders
  // must not. The resolved date is what is guarded, so a group pacing itself
  // onto nothing is covered as well as a run that has never been dated.
  const undated = resolveGroupCalendar(run({ startDate: "" }), null, dayOf(30));
  assert.equal(undated.currentWeek, null);
  assert.equal(undated.calendar.startDate, "");
  assert.equal(undated.totalWeeks, 8, "the plan is still readable without dates");

  // A garbled stored pace date normalises to TRACKING upstream, so the run's
  // date answers and the week is real. Pinned here so the null above cannot be
  // mistaken for "any group override can blank the calendar".
  const tracking = resolveGroupCalendar(
    run(),
    normalizeCourseGroup("g", { paceStartDate: "2026-02-31" }),
    dayOf(30),
  );
  assert.equal(tracking.currentWeek.weekNumber, 5);
});

test("GUARD: resolveGroupCalendars keys by id, on ONE clock, and dedupes", () => {
  const now = dayOf(30);
  const groups = [
    { id: "mon__a", ...pace() },
    { id: "thu__b", ...pace({ paceStartDate: addDaysToKey(START, 14) }) },
    // A repeat of the first id must not resolve twice, nor overwrite it.
    { id: "mon__a", ...pace({ paceStartDate: addDaysToKey(START, -7) }) },
  ];
  const byId = resolveGroupCalendars(run(), groups, now);

  assert.equal(byId.size, 2);
  assert.equal(byId.get("mon__a").currentWeek.weekNumber, 5);
  assert.equal(byId.get("thu__b").currentWeek.weekNumber, 3);
  // The shared clock is the point: the same `now` reaches every group, so a
  // request spanning a midnight cannot report its own timing as pacing.
  assert.deepEqual(byId.get("mon__a"), resolveGroupCalendar(run(), pace(), now));
});

// ---------------------------------------------------------------------------
// The overview payload's own ordering and shape (asserted at the source)
// ---------------------------------------------------------------------------

test("GUARD: the overview resolves ownGroup BEFORE any calendar", () => {
  // Load-bearing, and stated as such in the route: the group is the first half
  // of every resolution below it. A calendar resolved first would have nothing
  // to resolve THROUGH, and the fix for the two-group case would silently
  // become "pick one".
  const ownGroupAt = OVERVIEW.indexOf("const ownGroup =");
  const calendarAt = OVERVIEW.indexOf("const own = calendarFor(ownGroup)");
  assert.ok(ownGroupAt > 0, "ownGroup is still resolved by that name");
  assert.ok(calendarAt > 0, "the caller's calendar is resolved through it");
  assert.ok(ownGroupAt < calendarAt, "ownGroup must be resolved first");
  // And the ordering is documented where it can be read, not only pinned here.
  assert.match(OVERVIEW, /RESOLVED BEFORE THE CALENDAR/);
});

test("GUARD: `group` stays NULL for a multi-group facilitator, never groups[0]", () => {
  // Two groups facilitated leaves `ownGroup` null by construction...
  assert.match(OVERVIEW, /\(facilitates\.length === 1 \? facilitates\[0\] : null\)/);
  // ...and `group` is derived from `ownGroup`, so it inherits that null.
  assert.match(
    OVERVIEW,
    /const group: OverviewGroup \| null =\s*\(ownGroup \? groupCardPayloads\.find/,
  );
  // The shim the contract forbids: `group` must never fall back to the first
  // card just because there is one.
  assert.doesNotMatch(OVERVIEW, /group\s*=\s*groupCardPayloads\[0\]/);
  assert.doesNotMatch(OVERVIEW, /groups\[0\]\s*\?\?/);
  // Deprecated, with the removal PR named (contract: kept for one release).
  assert.match(OVERVIEW, /@deprecated[\s\S]{0,160}REMOVED IN PR38/);
});

test("GUARD: every card is dated by ITS OWN group's week, not the caller's", () => {
  // The whole bug in one line: the slot fields resolve through the card's own
  // calendar. A single shared `weekId` computed once from the caller's current
  // week is what put the wrong week's room on a second group's card.
  assert.match(
    OVERVIEW,
    /const groupCalendar = calendarFor\(source\);\s*const session = sessionForWeek\(source, currentWeekId\(groupCalendar\.currentWeek\)\);/,
  );
  assert.doesNotMatch(OVERVIEW, /const weekId = currentWeekId\(currentWeek\)/);
  // Its range comes from the sessions resolved off the SAME calendar object,
  // never a second resolution of the same thing.
  assert.match(OVERVIEW, /resolveSessions\(run, source, groupCalendar\.calendar\)/);
});

test("GUARD: own attendance is a learner's own row, gated and never queried", () => {
  // Learner only: a facilitator runs the room and an admin reading over the
  // cohort's shoulder has no row of their own.
  assert.match(OVERVIEW, /liveEnrolment\?\.role === "learner" &&/);
  // And their OWN placement, matched by id. `ownGroup` falls back to the single
  // group the caller facilitates, so a learner whose own group is archived
  // would otherwise have their attendance read out of the registers of a room
  // they teach: real marks, belonging to somebody, under the wrong dates.
  assert.match(OVERVIEW, /ownGroup\?\.id === liveEnrolment\.groupId/);
  // Addressed by the construct-only id, never a query over the collection.
  assert.match(OVERVIEW, /attendanceDocId\(\s*runId,\s*ownLearnerGroup\.id,/);
  assert.doesNotMatch(OVERVIEW, /collection\("courseAttendance"\)\s*\.where/);
  // Projected through the shared helper rather than spread out of a register.
  assert.match(OVERVIEW, /ownAttendanceSessions\(actor\.uid, ownSessions, ownRegisters\)/);
  // The route never names the two fields the projection exists to keep out, so
  // there is no line here that could start carrying them by a small edit.
  assert.doesNotMatch(OVERVIEW, /participantNotes/);
  assert.doesNotMatch(OVERVIEW, /normalizeCourseAttendance/);
  // Bounded: a corrupt plan cannot turn one page load into an unbounded getAll.
  // The CAP EXPRESSION itself, not merely the identifier: a constant that is
  // named but never sliced with would satisfy a name-only assertion while the
  // read stayed unbounded.
  assert.match(OVERVIEW, /\.slice\(0, MAX_OWN_ATTENDANCE_SESSIONS\)/);
  // And bounded from the JOIN WEEK too, before the cap, so a mid-run joiner
  // neither fetches nor is shown the weeks before their placement.
  assert.match(
    OVERVIEW,
    /sessionsFromJoinWeek\(\s*resolveSessions\(run, ownLearnerGroup, own\.calendar\),\s*liveEnrolment\?\.joinedWeekNumber \?\? 1,\s*\)\.slice\(0, MAX_OWN_ATTENDANCE_SESSIONS\)/,
  );
});

test("GUARD: the route resolves every card's calendar through ONE shared pass", () => {
  // `resolveGroupCalendars` is the one-clock pass, and the route READS its map
  // rather than resolving per card in a closure: the caller's own group used to
  // be resolved twice, once for the top-level fields and again for its card.
  assert.match(OVERVIEW, /const groupCalendars = resolveGroupCalendars\(run, groupCards, now\)/);
  assert.match(OVERVIEW, /const resolved = groupCalendars\.get\(group\.id\)/);
  // The cards are built BEFORE the calendars, because they are the list the
  // pass is run over.
  assert.ok(
    OVERVIEW.indexOf("const groupCards: CourseGroupDoc[] = []") <
      OVERVIEW.indexOf("const groupCalendars = resolveGroupCalendars"),
  );
});

// ---------------------------------------------------------------------------
// ownAttendanceSessions: the projection, and what it must never carry
// ---------------------------------------------------------------------------

/** One session, shaped exactly as `resolveSessions` yields it. */
const ownSession = (weekNumber, dateKey, occurrence = 1) => ({
  weekNumber,
  weekId: weekDocId(weekNumber),
  occurrence,
  sessionKey:
    occurrence === 1
      ? weekDocId(weekNumber)
      : `${weekDocId(weekNumber)}-${occurrence}`,
  slotStartKey: dateKey,
  dateKey,
  session: {
    weekday: 2,
    startTimeLocal: "18:00",
    durationMinutes: 90,
    location: "Hallward B12",
    meetingUrl: null,
    notes: "",
  },
});

test("GUARD: an UNPUSHED register is invisible, by construction", () => {
  const sessions = [ownSession(1, "2026-09-29"), ownSession(2, "2026-10-06")];
  const registers = new Map([
    ["w01", { pushedAt: new Date("2026-09-29T20:00:00Z"), records: { ada: "present" } }],
    // Week 2 is a draft the facilitator is still saving during the session.
    ["w02", { pushedAt: null, records: { ada: "absent" } }],
  ]);

  const out = ownAttendanceSessions("ada", sessions, registers);
  assert.equal(out.length, 1, "only the pushed session travels");
  assert.equal(out[0].sessionKey, "w01");
  assert.equal(out[0].status, "present");
  // Not merely absent from the list: the draft's mark must appear nowhere.
  assert.ok(!JSON.stringify(out).includes("absent"));
});

test("GUARD: the projection carries no other uid's mark and no participant notes", () => {
  // THE SENTINEL. A register is the whole room's record plus the facilitator's
  // private notes about named students. The projection reads four fields and
  // copies nothing, so a field added to `courseAttendance` next term travels
  // nowhere by default.
  const sessions = [ownSession(1, "2026-09-29")];
  const registers = new Map([
    [
      "w01",
      {
        pushedAt: { toDate: () => new Date("2026-09-29T20:00:00Z") },
        records: { ada: "late", grace: "absent", linus: "excused" },
        participantNotes: {
          grace: "SECRET-NOTE-ABOUT-GRACE",
          ada: "SECRET-NOTE-ABOUT-ADA",
        },
        pushedByUid: "facilitator-uid",
        markedByUid: "facilitator-uid",
        notes: "SECRET-SESSION-NOTE",
      },
    ],
  ]);

  const out = ownAttendanceSessions("ada", sessions, registers);
  const wire = JSON.stringify(out);

  assert.equal(out.length, 1);
  assert.equal(out[0].status, "late", "the caller's own mark is the one fact kept");
  for (const leak of [
    "grace",
    "linus",
    "SECRET-NOTE-ABOUT-GRACE",
    "SECRET-NOTE-ABOUT-ADA",
    "SECRET-SESSION-NOTE",
    "facilitator-uid",
    "participantNotes",
    "records",
  ]) {
    assert.ok(!wire.includes(leak), `the payload must not carry ${leak}`);
  }
  assert.deepEqual(Object.keys(out[0]).sort(), [
    "dateKey",
    "held",
    "occurrence",
    "sessionKey",
    "status",
    "weekNumber",
  ]);
});

test("GUARD: an unmarked cell in a pushed register is null here, not 'absent'", () => {
  // The rollup counts it as an absence (its rule 4). The per-session list is a
  // record of what was WRITTEN DOWN, so a page can say "not marked" instead of
  // accusing someone of missing a session nobody recorded. The disagreement is
  // deliberate and both halves ship on the same payload.
  const sessions = [ownSession(1, "2026-09-29"), ownSession(2, "2026-10-06")];
  const registers = new Map([
    ["w01", { pushedAt: new Date(), records: { grace: "present" } }],
    // A cancelled session: held false removes it from every denominator.
    ["w02", { pushedAt: new Date(), held: false, records: {} }],
  ]);

  const out = ownAttendanceSessions("ada", sessions, registers);
  assert.deepEqual(
    out.map((s) => [s.sessionKey, s.status, s.held]),
    [
      ["w01", null, true],
      ["w02", null, false],
    ],
  );
});

test("GUARD: a mid-run joiner has no row before the week they joined", () => {
  // THE BUG THIS PINS: the projection was handed every session of the term, so
  // somebody added in week 4 read three "Not marked" rows for a room they had
  // not joined, directly beside a rollup whose denominator starts at week 4.
  const sessions = [1, 2, 3, 4, 5].map((n) =>
    ownSession(n, `2026-09-${String(21 + (n - 1) * 7).padStart(2, "0")}`),
  );
  const kept = sessionsFromJoinWeek(sessions, 4);

  assert.deepEqual(
    kept.map((s) => s.weekNumber),
    [4, 5],
  );
  // The filter is what the projection then reads, so the pre-join weeks cannot
  // reappear as rows even when their registers were pushed.
  const registers = new Map(
    sessions.map((s) => [s.sessionKey, { pushedAt: new Date(), records: {} }]),
  );
  assert.deepEqual(
    ownAttendanceSessions("ada", kept, registers).map((s) => s.weekNumber),
    [4, 5],
  );
  // Week 1 is the floor and the default: a joiner can only ever be shown MORE
  // of their own record, never less, on a missing or garbled number.
  for (const bad of [1, 0, -3, NaN, undefined]) {
    assert.equal(sessionsFromJoinWeek(sessions, bad).length, 5);
  }
  // A fractional week floors rather than rounding a joiner past a session.
  assert.deepEqual(
    sessionsFromJoinWeek(sessions, 3.7).map((s) => s.weekNumber),
    [3, 4, 5],
  );
  // A floor past the end of term is empty, not the whole term.
  assert.deepEqual(sessionsFromJoinWeek(sessions, 99), []);
});

test("GUARD: a garbled stored mark reads as unmarked, and no uid reads as nothing", () => {
  const sessions = [ownSession(1, "2026-09-29")];
  const registers = new Map([
    ["w01", { pushedAt: new Date(), records: { ada: "attended" } }],
  ]);
  assert.equal(ownAttendanceSessions("ada", sessions, registers)[0].status, null);
  assert.deepEqual(ownAttendanceSessions("", sessions, registers), []);
});

// ---------------------------------------------------------------------------
// The run home's own wiring (asserted at the source: React components cannot
// be imported by this loader any more than route handlers can)
// ---------------------------------------------------------------------------

const RUN_HOME = src("features", "courses", "RunHome.tsx");
const GROUP_PANEL = src("features", "courses", "FacilitatorGroupPanel.tsx");

test("GUARD: every card on the run home reads its OWN group's calendar", () => {
  // The facilitator card is a component precisely because each one needs its
  // own roster fetch, and it now needs its own calendar for the same reason.
  assert.match(GROUP_PANEL, /weekLine\(group\.calendar\)/);
  assert.match(GROUP_PANEL, /rangeLine\(group\.calendar\)/);
  assert.match(GROUP_PANEL, /nextLine\(group\.calendar\)/);
  // Including the materials link: a week handed down from the page would be
  // the caller's, which for a two-group facilitator is the run's and so
  // neither group's.
  assert.match(GROUP_PANEL, /materialsWeek\(group\.calendar, publishedWeekNumbers\)/);
  assert.doesNotMatch(GROUP_PANEL, /targetWeekNumber: number \| null/);

  // The session card is dated by its own group too, not by the page's week.
  assert.match(RUN_HOME, /slotStartKey=\{group\.calendar\.currentWeek\?\.slotStartKey \?\? null\}/);
  assert.match(RUN_HOME, /const cardCurrentWeek = group\?\.calendar\.currentWeek \?\? null;/);
});

test("GUARD: the run home links the progress page and shows own attendance", () => {
  // /learn/[runId]/progress shipped with no link to it from anywhere. This is
  // the link, and it sits on the same card as the member's own record.
  assert.match(RUN_HOME, /\/progress`\}/);
  assert.match(RUN_HOME, /<ProgressPanel runId=\{runId\} ownAttendance=\{data\.ownAttendance\} \/>/);
  // Learners only: a facilitator has no attendance of their own.
  assert.match(RUN_HOME, /\{access\.isEnrolled && \(/);
  // An unmarked cell reads as unmarked, never as an absence, on the row that
  // reports what was written down. (The rollup counts it as an absence, which
  // is what the summary line above the list is built from.)
  assert.match(RUN_HOME, /: "Not marked"/);
  // And the copy says why a session might be missing from the list at all.
  assert.match(RUN_HOME, /once your facilitator finishes each/);
  // A learner with no group yet gets their own sentence: the standing copy
  // names a facilitator they have not got one of.
  assert.match(RUN_HOME, /ownAttendance === null \? \(/);
  assert.match(RUN_HOME, /placed in a group soon/);
});

test("GUARD: one spelling of a week URL, shared by both surfaces", () => {
  // The panel used to re-inline the template literal the run home held
  // locally, `encodeURIComponent` being the half that goes missing when a link
  // is retyped two components apart.
  const LINKS = src("features", "courses", "links.ts");
  assert.match(LINKS, /export function weekHref\(runId: string, weekNumber: number\)/);
  assert.match(LINKS, /\/learn\/\$\{encodeURIComponent\(runId\)\}\/weeks\/\$\{weekNumber\}/);
  for (const file of [RUN_HOME, GROUP_PANEL]) {
    assert.match(file, /from "\.\/links"/);
    assert.match(file, /weekHref\(runId, /);
    assert.doesNotMatch(file, /\/weeks\/\$\{[a-zA-Z]/);
  }
});

test("GUARD: the progress page is linked from the run's sub nav too", () => {
  // The contract resolves this page's orphan status by linking it from the run
  // sub nav. There is no standing nav component under `/learn/[runId]`, so the
  // week header's eyebrow row (the one run-scoped nav on every page inside a
  // run) carries it, and the run home's card link is no longer the only door.
  const WEEK_VIEW = src("features", "courses", "WeekView.tsx");
  assert.match(WEEK_VIEW, /href=\{`\$\{runHomeHref\}\/progress`\}/);
  assert.match(WEEK_VIEW, /THE RUN'S SUB NAV/);
});
