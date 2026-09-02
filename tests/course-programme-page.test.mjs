/**
 * Unit tests for V3 W2 PR13: the public programme page.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies beyond the
 * `typescript` devDependency the sibling suites already load).
 *
 * ## Why this file exists
 *
 * §1 THE BYTE-IDENTICAL WEEK CONTRACT. `WeekCurriculum` is rendered on the
 * public week page AND inside the member learning space, which hangs its
 * check-off controls off it through render props. Its own module comment
 * promises that with EVERY optional prop absent the output is what the public
 * page originally shipped. Three separate wave-3 PRs are queued against that
 * component (overlays, stream filtering, dates), so the promise needs to be
 * something a test can break rather than something a reviewer has to notice.
 * The programme page renders the sample week through the same component with
 * no props, which is why the guard lands here.
 *
 * §2 THE LIVE ROUND. `courseRuns.admissionRoundIds` does not exist yet, so the
 * page derives its round by asking which rounds name one of the course's runs
 * and then RANKING them. The ranking is the part worth pinning: open beats
 * opening-soon beats closed, a draft round is not a candidate at all, and "no
 * round" is an ordinary answer that sends the page back to the run's window.
 * The round then names the run whose cohort and start date the page prints,
 * which is a second thing worth pinning: that run is normally still `draft`,
 * so it is never the featured run, and taking those two rows from the featured
 * run captions a live deadline with a previous intake's dates.
 *
 * §3 THE LONDON DAY BOUNDARY. The journey strip marks the step the reader is
 * standing in by comparing civil date keys, and the key comes from
 * `londonDateKey`. Comparing instants instead would name a deadline a day
 * early for eight hours of every London day. The test drives the two instants
 * either side of a London midnight and asserts the step flips between them.
 *
 * §4 NO RAW RUN LABEL. `cohortLabel(run)` is the one formatter, and
 * `run.label` survives on the document for admin lists only. A source pin,
 * because there is no type error for printing the wrong string field.
 *
 * §5 CATALOGUE ORDER. What you can apply to now comes first. Alphabetical
 * order buried an open intake behind three closed fellowships because of a
 * letter, which is the whole reason the comparator exists.
 *
 * ## The loader dance
 *
 * Lifted from `course-pages.test.mjs`, plus two additions §1 needs: a CSS
 * module stub (Node cannot import one, and a Proxy returning the key makes the
 * rendered class names stable and readable) and JSX transpilation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() { return globalThis.__TEST_ADMIN_DB__ ?? null; }",
  ],
]);

/**
 * CSS modules resolve to a Proxy that returns the requested key, so
 * `styles.week` renders as `class="week"`. That is what makes §1's frozen
 * markup readable: a hashed build-time class name would turn the snapshot into
 * noise and would change on an unrelated edit.
 */
const CSS_MODULE_STUB =
  "export default new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? key : '') });";

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

let cssStubUrl = null;
function cssUrl() {
  if (!cssStubUrl) cssStubUrl = dataUrl(CSS_MODULE_STUB);
  return cssStubUrl;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  if (file.endsWith(".css")) return cssUrl();
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
      // The automatic runtime, so a component file needs no React import of
      // its own, exactly how Next compiles it.
      jsx: tsc.JsxEmit.ReactJSX,
      jsxImportSource: "react",
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.endsWith(".css")) {
      rewrites.set(specifier, cssUrl());
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

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code, not a model.
// ---------------------------------------------------------------------------

const { pickLiveRound } = await loadTs("lib/admissions/liveRound.ts");
const { currentJourneyStepIndex, journeyStepStates } = await loadTs(
  "lib/courses/journeyStep.ts",
);
const { londonDateKey } = await loadTs("lib/courses/weekPlan.ts");
const { compareCatalogueEntries, roundOwnsDates, roundTargetRun } = await loadTs(
  "features/courses/fetchCourses.ts",
);
const { default: WeekCurriculum } = await loadTs(
  "features/courses/WeekCurriculum.tsx",
);
const { renderToStaticMarkup } = await import("react-dom/server");

/**
 * Source read with its COMMENTS STRIPPED. §4 asks whether the code reads
 * `run.label`, and both files explain at length why they do not: a naive
 * source pin fails on its own documentation, and the obvious way to make it
 * pass again is to delete the explanation.
 */
function codeOnly(relativePath) {
  return readFileSync(join(SRC, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE_SOURCE = codeOnly("app/(public)/courses/[courseId]/page.tsx");
const CTA_SOURCE = codeOnly("features/courses/CourseCTA.tsx");
const LIVE_ROUND_SOURCE = codeOnly("features/courses/fetchLiveRound.ts");

// ---------------------------------------------------------------------------
// §1 The byte-identical public week render
// ---------------------------------------------------------------------------

/**
 * A week exercising every limb of the spine: a guide block, all four material
 * kinds, an exercise and a checklist item. A fixture that only used one kind
 * would let three quarters of the component change without failing.
 */
const SAMPLE_WEEK = {
  id: "w3",
  runId: "run-1",
  weekNumber: 3,
  title: "Goal misgeneralisation",
  summary: "Why a model that scores well can still be doing the wrong thing.",
  published: true,
  guideBlocks: [{ id: "b1", type: "richText", html: "<p>Read in this order.</p>" }],
  materials: [
    {
      id: "m1",
      type: "reading",
      title: "Goal misgeneralisation in deep RL",
      url: "https://example.org/paper",
      author: "Langosco et al.",
      estimatedMinutes: 40,
    },
    {
      id: "m2",
      type: "video",
      title: "A short talk",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      estimatedMinutes: 12,
    },
    {
      id: "m3",
      type: "link",
      title: "The interactive demo",
      url: "https://example.org/demo",
      description: "Ten minutes of clicking",
    },
    { id: "m4", type: "note", title: "Skim the appendix", body: "It is short." },
  ],
  exercises: [
    { id: "e1", prompt: "Describe a case you have seen.", responseType: "text" },
  ],
  checklist: [
    { id: "c1", title: "Bring a question", detail: "One is enough.", mirrorToMyWork: false },
  ],
};

/**
 * THE FROZEN RENDER. Regenerate it ONLY when you have decided, on purpose, to
 * change what a logged-out visitor sees on a week: this string is the public
 * contract, and the member surface's render props are supposed to add to it
 * rather than to move it.
 *
 * The class names are the CSS-module keys (see the loader), so a renamed class
 * fails here too, which is correct: `WeekView.module.css` styles this DOM with
 * STRUCTURAL selectors and a renamed class is a broken member surface.
 */
function publicRender() {
  return renderToStaticMarkup(WeekCurriculum({ week: SAMPLE_WEEK }));
}

/**
 * The frozen markup lives in a FILE rather than in a string literal here, so a
 * change to the public week shows up as a readable diff in review instead of
 * as one 4KB line moving. Delete it and run the suite twice to regenerate: the
 * first run writes it and FAILS (so a missing golden file can never pass
 * silently), the second compares against it.
 */
const GOLDEN = join(REPO_ROOT, "tests/fixtures/week-curriculum-public.html");

test("§1 GUARD the public week render is byte-identical with no optional prop", () => {
  const html = publicRender();

  if (!existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, html);
    assert.fail(
      "tests/fixtures/week-curriculum-public.html was missing. It has just been"
        + " written from the current render: read the diff, decide whether the"
        + " change to the public week was intended, and commit it.",
    );
  }
  assert.equal(
    html,
    readFileSync(GOLDEN, "utf8"),
    "the public week render changed. If that was deliberate, delete"
      + " tests/fixtures/week-curriculum-public.html and re-run twice to refreeze"
      + " it; if it was not, the member surface has leaked into the public page.",
  );

  // Rendered twice: a component that reached for a clock, a random id or a
  // module-level counter would differ between the two, and every one of those
  // would be a hydration bug on the real page as well.
  assert.equal(html, publicRender());

  // The spine, in order. Asserted as a SEQUENCE rather than as four
  // independent matches, because "the sections are all present" is true of a
  // page that renders them backwards.
  const order = ["guide", "materials", "exercises", "checklist"].map((section) =>
    html.indexOf(`class="${section}`),
  );
  for (const at of order) assert.ok(at >= 0, `missing section in: ${html}`);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], "the week's sections rendered out of order");
  }

  // Every material kind survives, and the two that are not links are not
  // links: a `note` has nowhere to go, and an unparseable URL renders as text.
  assert.match(html, /Goal misgeneralisation in deep RL/);
  assert.match(html, /href="https:\/\/example\.org\/paper"/);
  assert.match(html, /Skim the appendix/);
  assert.match(html, /Describe a case you have seen\./);
  assert.match(html, /Bring a question/);

  // The ONE dangerouslySetInnerHTML on the page is BlockView's guide block.
  assert.match(html, /<p>Read in this order\.<\/p>/);
});

test("§1 GUARD the contract is PROP PRESENCE, so the member surface's slots really are absent", () => {
  // The component's own words: "the prop-presence check below is what keeps
  // that output byte-identical". It is presence, NOT the returned value: a
  // render prop that returns null still opens its wrapper element. That is
  // deliberate (the member surface needs the slot reserved so a row does not
  // reflow when its control resolves), and it is why the public page must pass
  // no props at all rather than pass ones that return null.
  //
  // This test is the other half of the frozen render above: it proves the
  // absence is load-bearing rather than incidental, by showing that supplying
  // the props changes the markup.
  const bare = publicRender();
  const withSlots = renderToStaticMarkup(
    WeekCurriculum({
      week: SAMPLE_WEEK,
      renderMaterialAction: () => null,
      renderMaterialExtra: () => null,
      renderChecklistAction: () => null,
      renderChecklistNote: () => null,
      renderExerciseAction: () => null,
    }),
  );
  assert.notEqual(withSlots, bare);
  assert.doesNotMatch(bare, /materialAction/);
  assert.match(withSlots, /materialAction/);
});

// ---------------------------------------------------------------------------
// §2 The live round
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-15T12:00:00Z");

function round(id, extra) {
  return {
    id,
    status: "open",
    archived: false,
    opensAt: null,
    closesAt: null,
    ...extra,
  };
}

test("§2 MODEL open beats opening-soon beats closed", () => {
  const openNow = round("open-now", {
    opensAt: new Date("2026-09-01T00:00:00Z"),
    closesAt: new Date("2026-10-18T22:59:00Z"),
  });
  const upcoming = round("upcoming", {
    opensAt: new Date("2026-11-01T00:00:00Z"),
  });
  const shut = round("shut", { status: "closed" });

  // Every ordering of the same three rounds picks the same one: the ranking
  // has to be a total order, not a first-past-the-post over query order.
  for (const list of [
    [openNow, upcoming, shut],
    [shut, upcoming, openNow],
    [upcoming, shut, openNow],
  ]) {
    assert.equal(pickLiveRound(list, NOW)?.round.id, "open-now");
  }

  assert.equal(pickLiveRound([upcoming, shut], NOW)?.round.id, "upcoming");
  assert.equal(pickLiveRound([shut], NOW)?.round.id, "shut");
});

test("§2 GUARD a draft round is not a candidate, so the page falls back", () => {
  // `roundWindowState` calls a draft round `inactive`: not a public thing at
  // all. Advertising an unfinished draft's opening date would promise a date
  // nobody has committed to. The page then renders the RUN's window, which is
  // what `null` here means to the caller.
  const draft = round("draft", {
    status: "draft",
    opensAt: new Date("2026-11-01T00:00:00Z"),
  });
  assert.equal(pickLiveRound([draft], NOW), null);

  // Same for an archived round, whatever its status says.
  assert.equal(pickLiveRound([round("gone", { archived: true })], NOW), null);

  // And no rounds at all is the ordinary case for an open-enrolment course.
  assert.equal(pickLiveRound([], NOW), null);
});

test("§2 MODEL two open rounds: the soonest deadline wins", () => {
  const soon = round("soon", { closesAt: new Date("2026-10-18T22:59:00Z") });
  const later = round("later", { closesAt: new Date("2026-12-13T23:59:00Z") });
  const unbounded = round("unbounded");
  assert.equal(pickLiveRound([later, soon], NOW)?.round.id, "soon");
  assert.equal(pickLiveRound([unbounded, later], NOW)?.round.id, "later");
});

test("§2 MODEL two closed rounds: the most recent one wins", () => {
  // The fortnight between a deadline and a decision is exactly when someone
  // reads this page, and last autumn's round is not the one they mean.
  const lastYear = round("last-year", {
    status: "closed",
    closesAt: new Date("2025-10-19T22:59:00Z"),
  });
  const thisYear = round("this-year", {
    status: "closed",
    closesAt: new Date("2026-08-30T22:59:00Z"),
  });
  assert.equal(pickLiveRound([lastYear, thisYear], NOW)?.round.id, "this-year");
  assert.equal(pickLiveRound([thisYear, lastYear], NOW)?.round.id, "this-year");
});

test("§2 MODEL the round names the run whose cohort and start date the page prints", () => {
  // THE BUG this pins. `getCourseRunSet`'s featured run is picked from runs
  // whose OWN window is live, and an open round's target run is normally still
  // `draft`: so the featured run is, by construction, never the run an open
  // round places people onto. Reading the chip and the Starts row off it
  // captions this round's deadline with a different intake's dates.
  const autumn = { id: "autumn-run", courseId: "fellowship", startDate: "2026-10-26" };
  const lastTerm = { id: "spring-run", courseId: "fellowship", startDate: "2026-01-19" };
  const otherCourse = { id: "incubator-run", courseId: "incubator", startDate: "2026-10-05" };
  const runs = new Map([
    [autumn.id, autumn],
    [lastTerm.id, lastTerm],
    [otherCourse.id, otherCourse],
  ]);

  // 1. THE TARGET RUN RESOLVES. One intake feeds several courses, so the first
  //    outcome run that belongs to THIS course wins, not simply the first.
  const shared = { outcomeRunIds: [otherCourse.id, autumn.id] };
  assert.equal(roundTargetRun(shared, runs, "fellowship")?.id, "autumn-run");
  assert.equal(roundTargetRun(shared, runs, "incubator")?.id, "incubator-run");

  // 2. NONE RESOLVES. An appointment round places nobody onto a run, and an
  //    intake whose targets are not chosen yet names none either. Null, so the
  //    caller prints no cohort and no start date, rather than reaching for
  //    `lastTerm` and dating a live deadline from January.
  assert.equal(roundTargetRun({ outcomeRunIds: [] }, runs, "fellowship"), null);
  assert.equal(roundTargetRun({ outcomeRunIds: ["deleted-run"] }, runs, "fellowship"), null);
  // A run of ANOTHER course is not this course's target either.
  assert.equal(
    roundTargetRun({ outcomeRunIds: [otherCourse.id] }, runs, "fellowship"),
    null,
  );

  // 3. NO ROUND. The ordinary case for an open-enrolment course, and the one
  //    that sends the page back to the featured run's own dates.
  assert.equal(roundTargetRun(null, runs, "fellowship"), null);
});

test("§2 GUARD the projection carries the run ids, because that is the join", () => {
  // `outcomeRunIds` is the only thing in the round projection that is not
  // printable, and it is there because the resolution above has nothing to
  // work with otherwise. If a future edit drops it from the type, the chip
  // silently goes back to the featured run's cohort with no test failing, so
  // the field is pinned at its source.
  assert.match(LIVE_ROUND_SOURCE, /outcomeRunIds: string\[\];/);
  assert.match(LIVE_ROUND_SOURCE, /outcomeRunIds: round\.outcomeRunIds,/);
});

test("§2 GUARD a passed deadline closes an OPEN round, so the CTA cannot offer a dead form", () => {
  const passed = round("passed", {
    status: "open",
    closesAt: new Date("2026-09-01T22:59:00Z"),
  });
  const picked = pickLiveRound([passed], NOW);
  assert.equal(picked?.window.state, "closed");
});

// ---------------------------------------------------------------------------
// §3 The London day boundary
// ---------------------------------------------------------------------------

const JOURNEY = [
  { label: "Applications open", dateKey: "2026-09-21" },
  { label: "Applications close", dateKey: "2026-10-18" },
  { label: "Decisions", dateKey: "2026-10-23" },
  { label: "First session", dateKey: "2026-10-26" },
];

test("§3 GUARD the current step flips at LONDON midnight, not at UTC midnight", () => {
  // 22:30 UTC on 18 October 2026 is 23:30 in London (BST, UTC+1), still the
  // 18th: the deadline day. Half an hour later it is the 19th in London while
  // it is still the 18th in UTC. A comparison done on instants, or on a
  // browser's local day, gets this wrong for an hour every night and for eight
  // hours a day for a visitor in California.
  const beforeMidnight = new Date("2026-10-18T22:30:00Z");
  const afterMidnight = new Date("2026-10-18T23:30:00Z");

  assert.equal(londonDateKey(beforeMidnight), "2026-10-18");
  assert.equal(londonDateKey(afterMidnight), "2026-10-19");

  // On the deadline day the CLOSE step is current, not the one after it.
  assert.equal(currentJourneyStepIndex(JOURNEY, londonDateKey(beforeMidnight)), 1);
  // The next London day it is still the close step (nothing else has arrived),
  // and the states either side of it have moved.
  assert.equal(currentJourneyStepIndex(JOURNEY, londonDateKey(afterMidnight)), 1);
  assert.deepEqual(journeyStepStates(JOURNEY, "2026-10-23"), [
    "past",
    "past",
    "current",
    "upcoming",
  ]);
});

test("§3 MODEL before the term starts nothing is current, and undated steps never are", () => {
  assert.equal(currentJourneyStepIndex(JOURNEY, "2026-09-01"), -1);
  assert.deepEqual(journeyStepStates(JOURNEY, "2026-09-01"), [
    "upcoming",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);

  // A step with no date is a real step ("six sessions") with no day to arrive
  // on. It renders, and it never becomes the current one by itself.
  const mixed = [
    { label: "Applications open", dateKey: "2026-09-21" },
    { label: "Six weekly sessions" },
  ];
  assert.equal(currentJourneyStepIndex(mixed, "2026-11-01"), 0);
});

test("§3 MODEL two steps on the same day: the later one wins", () => {
  const sameDay = [
    { label: "Applications close", dateKey: "2026-10-18" },
    { label: "Review starts", dateKey: "2026-10-18" },
  ];
  assert.equal(currentJourneyStepIndex(sameDay, "2026-10-18"), 1);
});

// ---------------------------------------------------------------------------
// §4 No raw run label reaches the page
// ---------------------------------------------------------------------------

test("§4 GUARD the programme page never reads run.label", () => {
  // `run.label` is the admin-facing handle somebody typed ("wd", while
  // testing). It survives on the document for admin lists and V3 stopped
  // showing it to visitors, and there is no type error for printing the wrong
  // string field, so this is a source pin.
  assert.doesNotMatch(PAGE_SOURCE, /\brun\.label\b/);
  assert.doesNotMatch(PAGE_SOURCE, /showcaseRun\.label/);
  // What it reads instead.
  assert.match(PAGE_SOURCE, /cohortLabel\(/);
  assert.match(PAGE_SOURCE, /from "@\/lib\/courses\/cohortLabel"/);
});

test("§4 GUARD the CTA chip is the cohort, and is omitted rather than guessed", () => {
  assert.doesNotMatch(CTA_SOURCE, /\brun\.label\b/);
  // The chip is ONE resolved value, and both halves of it are a `cohortLabel`
  // the server produced: the round's target run when a round owns the page,
  // the featured run otherwise. Rendering it is a plain truthiness test, so an
  // absent cohort omits the chip rather than falling back to anything.
  assert.match(CTA_SOURCE, /const chip = viaRound \? round\.cohortLabel : \(run\?\.cohortLabel \?\? ""\);/);
  assert.match(CTA_SOURCE, /\{chip \? \(/);
});

// ---------------------------------------------------------------------------
// §5 Catalogue order
// ---------------------------------------------------------------------------

function entry(id, { track = "general", roundState = null, runState = null } = {}) {
  return {
    course: { id, title: id, track },
    liveRound: roundState
      ? { id: `${id}-round`, state: roundState, opensAt: null, closesAt: null, decisionsByDate: null }
      : null,
    featuredRun: runState
      ? { run: { id: `${id}-run` }, window: { state: runState, opensAt: null, closesAt: null } }
      : null,
    visual: { seed: id, coverImageUrl: null, coverAlt: "" },
  };
}

test("§5 MODEL open first, then opening soon, then everything else", () => {
  const rows = [
    entry("zeta-closed", { runState: "closed" }),
    entry("alpha-soon", { roundState: "not-yet" }),
    entry("omega-open", { roundState: "open" }),
    entry("beta-nothing"),
  ];
  const order = rows.sort(compareCatalogueEntries).map((e) => e.course.id);
  // Alphabetically this is alpha, beta, omega, zeta, which is exactly the
  // order that buried the one course taking applications.
  assert.deepEqual(order, ["omega-open", "alpha-soon", "beta-nothing", "zeta-closed"]);
});

test("§5 GUARD the ROUND outranks the run when the two disagree", () => {
  // A run whose own window has shut, fed by a round that is open: the round is
  // the object people apply to, so the card says open. This is the ordinary
  // state of an autumn intake whose target run is not enrolling yet.
  const roundOpen = entry("round-open", { roundState: "open", runState: "closed" });
  const runOpen = entry("run-open", { runState: "open" });
  const order = [roundOpen, runOpen].sort(compareCatalogueEntries).map((e) => e.course.id);
  assert.equal(order.length, 2);
  // Both rank as open, so the tie falls to track and then title.
  assert.deepEqual(order, ["round-open", "run-open"]);

  const closedByRound = entry("shut", { roundState: "closed", runState: "open" });
  assert.equal(compareCatalogueEntries(runOpen, closedByRound) < 0, true);
});

test("§5 GUARD ONE precedence rule, and an open-enrolment run is its exception", () => {
  // The bug this pins: the catalogue applied "round first, always" while the
  // programme page applied "round first UNLESS the run is open enrolment", so
  // a pre-course that a round happened to name sorted by the round's deadline
  // on one page and by its own sign-up window on the other.
  const live = { state: "open" };

  // The ordinary case: a round exists, so the round speaks.
  assert.equal(roundOwnsDates(live, "admissions"), true);
  // A run with no mode recorded is not an open-enrolment run.
  assert.equal(roundOwnsDates(live, null), true);
  assert.equal(roundOwnsDates(live, undefined), true);

  // THE exception. A pre-course admits everybody from the session picker on
  // the course page; an application deadline is not a true thing about it.
  assert.equal(roundOwnsDates(live, "open"), false);

  // No round at all is the ordinary answer for an open-enrolment course and
  // for an admissions course between intakes.
  assert.equal(roundOwnsDates(null, "admissions"), false);

  // A draft or archived round is not a public thing, so it speaks for nothing
  // even though the ranking should never have handed one over.
  assert.equal(roundOwnsDates({ state: "inactive" }, "admissions"), false);

  // And the sort key asks the same question: a round-open pre-course sorts on
  // its own closed sign-up window, not on the round's open one.
  const preCourse = {
    course: { id: "pre", title: "pre", track: "general" },
    liveRound: { id: "r", state: "open", opensAt: null, closesAt: null, decisionsByDate: null },
    featuredRun: {
      run: { id: "pre-run", enrolMode: "open" },
      window: { state: "closed", opensAt: null, closesAt: null },
    },
    visual: { seed: "pre", coverImageUrl: null, coverAlt: "" },
  };
  const openIntake = entry("intake", { roundState: "open" });
  assert.equal(compareCatalogueEntries(openIntake, preCourse) < 0, true);
});

test("§5 MODEL inside a band, track order then title", () => {
  const rows = [
    entry("general-b", { track: "general", roundState: "open" }),
    entry("technical-b", { track: "technical", roundState: "open" }),
    entry("technical-a", { track: "technical", roundState: "open" }),
    entry("governance-a", { track: "governance", roundState: "open" }),
  ];
  const order = rows.sort(compareCatalogueEntries).map((e) => e.course.id);
  assert.deepEqual(order, [
    "technical-a",
    "technical-b",
    "governance-a",
    "general-b",
  ]);
});
