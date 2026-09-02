/**
 * Unit tests for V3 W1 PR7: the AUTHORED PUBLIC PAGE object, the cohort
 * formatter, and the two courseRuns fields that ship with them.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * §1 THE SCRIPT TAG. `coursePages.pitchBlocks` is the one place in the courses
 * feature where stored HTML reaches `dangerouslySetInnerHTML` on a LOGGED-OUT
 * page. `sanitizeBlocks` does not help: it is `raw.filter(isValidBlock)`, a
 * SHAPE filter, and a `richText` block whose `html` is `<script>…</script>`
 * passes it unchanged. The collection is `allow write: if false` and one route
 * writes it, and `normalizeCoursePage` neuters again at READ time so that a
 * row which arrived some other way (a console edit, a restored backup, a
 * future route) is still harmless. That read-time promise is what this
 * section pins, and no type checker can see it.
 *
 * §2 THE CAPS AND THE SHAPES. Every list on the page has a ceiling and every
 * row is rebuilt key by key, so a field added to the type but not to a
 * sanitiser validates cleanly and then silently never persists (the lesson
 * `course-streams.test.mjs` records for `streamIds`).
 *
 * §3 THE COHORT IS ABSENT, NEVER NULL. `firestore.rules` caps the field with
 * `request.resource.data.get('cohort', {}).keys().hasOnly([...])`, and
 * `.keys()` on a stored null raises, denying the write. So `updateRun` must
 * clear the field with `deleteField()`, never by writing null: the same trap
 * already recorded for `submissionExerciseRef`. Source-pinned, because the
 * failure it prevents is a run nobody can edit again.
 *
 * §2c THE FETCHER RETURNS LESS THAN IT READS. `fetchCoursePage` hands back a
 * `PublicCoursePage`, which is the stored document minus the staff-facing
 * provenance pair. `themesSourceLabel` can be a run's free-text label, the
 * exact string V3 stopped showing visitors, so the assertion is on the KEY
 * being absent rather than on its value: a renderer cannot print a key that is
 * not there, and a future `{...page}` spread cannot leak one either.
 *
 * §4 ONE COHORT FORMATTER, ALWAYS SHOWING THE NUMBER. `cohortLabel` is the
 * only function that turns the stored triple into words, and the decision that
 * the cohort number always shows is deliberate: the function sees one run and
 * cannot know how many siblings exist, so a label that gained ", cohort 1" the
 * day a second cohort appeared would make a sent email and a live page
 * disagree about the name of the same thing.
 *
 * ## The loader dance
 *
 * Lifted verbatim from `course-streams.test.mjs`, which already solved
 * importing TypeScript (and `@/…` aliases) from `.mjs` on this repo's Node.
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
 * See `course-nudge.test.mjs`; nothing here is reachable from an assertion,
 * EXCEPT the admin stub, which §2c drives on purpose. `getAdminDb` reads a
 * global rather than closing over a fixture so one test can hand the fetcher a
 * stored row and the next can hand it nothing.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() { return globalThis.__TEST_ADMIN_DB__ ?? null; }",
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

const {
  COURSE_PAGE_LIMITS,
  canAuthorCoursePage,
  coursePageHasContent,
  emptyCoursePage,
  neuterRichTextHtml,
  normalizeCoursePage,
  sanitizeCoursePageBlocks,
  sanitizeFaq,
  sanitizeJourney,
  sanitizeWeeklyThemes,
  toPublicCoursePage,
} = await loadTs("lib/firestore/coursePages.ts");

const { fetchCoursePage } = await loadTs("features/courses/fetchCoursePage.ts");

const {
  COHORT_LIMITS,
  COHORT_TERMS,
  cohortError,
  cohortLabel,
  cohortTermLabel,
  normalizeCohort,
} = await loadTs("lib/courses/cohortLabel.ts");

const { COURSE_FIELD_LIMITS, normalizeCourseRun } = await loadTs(
  "lib/firestore/courses.ts",
);

/**
 * Read as TEXT, not imported: `courseMutations.ts` is a client module that
 * boots the Firebase client SDK on import, and the property being pinned is a
 * structural one about which Firestore sentinel a branch reaches for.
 */
const MUTATIONS = readFileSync(
  join(SRC, "features/courses/courseMutations.ts"),
  "utf8",
);

const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

// ---------------------------------------------------------------------------
// §1 The script tag
// ---------------------------------------------------------------------------

function richText(html) {
  return { id: "b1", type: "richText", html };
}

test("§1 GUARD a stored script tag does not survive normalisation", () => {
  // The stored row is what an attacker who reached the collection some other
  // way would leave behind. `sanitizeBlocks` alone passes it: it only checks
  // that `html` is a string.
  const page = normalizeCoursePage("ai-safety-fundamentals__ab12cd34", {
    pitchBlocks: [
      richText('<p>Real copy.</p><script>fetch("/api/session")</script>'),
      richText("<p>More copy.</p>"),
    ],
  });

  assert.equal(page.pitchBlocks.length, 2);
  const [first] = page.pitchBlocks;
  assert.equal(first.html.includes("<script"), false);
  assert.equal(first.html.includes("fetch("), false);
  // The legitimate half of the block survives. A sanitiser that ate the
  // copy would be quietly reverted the first time an author noticed.
  assert.ok(first.html.includes("Real copy."));
});

test("§1 GUARD event handlers, javascript: hrefs and framed content all go", () => {
  const cases = [
    ['<img src="x" onerror="alert(1)">', ["onerror", "<img"]],
    ['<p onclick="alert(1)">hi</p>', ["onclick"]],
    ['<a href="javascript:alert(1)">click</a>', ["javascript:"]],
    ['<a href="java\nscript:alert(1)">click</a>', ["javascript:", "script:"]],
    ['<iframe src="https://evil.example"></iframe>', ["<iframe"]],
    ["<svg><script>alert(1)</script></svg>", ["<svg", "<script"]],
    ['<style>body{background:url("javascript:alert(1)")}</style>', ["<style", "javascript:"]],
    ['<p data-x="1" class="y">hi</p>', ["data-x", "class="]],
  ];
  for (const [html, forbidden] of cases) {
    const out = neuterRichTextHtml(html);
    for (const needle of forbidden) {
      assert.equal(
        out.toLowerCase().includes(needle.toLowerCase()),
        false,
        `${needle} survived ${html} as ${out}`,
      );
    }
  }
});

test("§1 MODEL ordinary rich text is preserved, tag for tag", () => {
  const html =
    '<h2>Who it is for</h2><p>Any student, <strong>no prerequisites</strong>.</p>'
    + '<ul><li>Six weeks</li><li>One session a week</li></ul>'
    + '<p><a href="https://naisi.uk/courses" title="Catalogue">the catalogue</a></p>';
  assert.equal(neuterRichTextHtml(html), html);
});

test("§1 GUARD an unwrapped tag keeps its text, and a bare angle bracket is escaped", () => {
  // A paste from a word processor arrives wrapped in divs and spans. Losing
  // the wrapper is fine; losing the sentence is not.
  assert.equal(neuterRichTextHtml("<div>kept</div>"), "kept");
  // A lone `<` is text, and must not be able to re-form into a tag when the
  // surrounding copy is concatenated.
  assert.equal(neuterRichTextHtml("5 < 6"), "5 &lt; 6");
});

test("§1 GUARD the neutering runs at BOTH ends, so one miss is not enough", () => {
  // The write end (the route) and the read end (the normaliser) call the same
  // function. This pins the read end, which is the one a stored row bypasses.
  const stored = { pitchBlocks: [richText("<script>x</script><p>ok</p>")] };
  assert.equal(
    normalizeCoursePage("c1", stored).pitchBlocks[0].html.includes("<script"),
    false,
  );
  assert.equal(
    sanitizeCoursePageBlocks(stored.pitchBlocks)[0].html.includes("<script"),
    false,
  );
});

// ---------------------------------------------------------------------------
// §2 Caps and shapes
// ---------------------------------------------------------------------------

test("§2 GUARD every list is capped at the number the editor and the route agree on", () => {
  const blocks = Array.from({ length: 60 }, (_, i) => ({
    id: `b${i}`,
    type: "divider",
  }));
  assert.equal(
    sanitizeCoursePageBlocks(blocks).length,
    COURSE_PAGE_LIMITS.maxPitchBlocks,
  );

  const themes = Array.from({ length: 40 }, (_, i) => ({
    weekNumber: i + 1,
    title: `Week ${i + 1}`,
    blurb: "x",
  }));
  assert.equal(
    sanitizeWeeklyThemes(themes).length,
    COURSE_PAGE_LIMITS.maxWeeklyThemes,
  );

  const faq = Array.from({ length: 30 }, (_, i) => ({ q: `q${i}`, a: "a" }));
  assert.equal(sanitizeFaq(faq).length, COURSE_PAGE_LIMITS.maxFaq);

  const journey = Array.from({ length: 20 }, (_, i) => ({
    label: `step ${i}`,
    detail: "",
  }));
  assert.equal(sanitizeJourney(journey).length, COURSE_PAGE_LIMITS.maxJourney);
});

test("§2 MODEL weekly themes are deduplicated by week and sorted", () => {
  // A duplicated week renders the same week twice and makes "week 4 of 8" a
  // lie on a list the visitor is counting.
  const themes = sanitizeWeeklyThemes([
    { weekNumber: 3, title: "Third", blurb: "c" },
    { weekNumber: 1, title: "First", blurb: "a" },
    { weekNumber: 3, title: "Third again", blurb: "duplicate" },
    { weekNumber: 0, title: "Zero", blurb: "out of range" },
    { weekNumber: 999, title: "Way out", blurb: "out of range" },
  ]);
  assert.deepEqual(
    themes.map((t) => t.weekNumber),
    [1, 3],
  );
  assert.equal(themes[1].title, "Third");
});

test("§2 GUARD a journey step's dateKey is ABSENT unless it is a real day", () => {
  // `2026-02-31` matches the shape and is not a day. The strip marks the
  // current step by comparing date keys, so a shape-only check would mark the
  // wrong step rather than none.
  const steps = sanitizeJourney([
    { label: "Applications open", detail: "", dateKey: "2026-09-21" },
    { label: "Impossible", detail: "", dateKey: "2026-02-31" },
    { label: "Garbled", detail: "", dateKey: "next tuesday" },
    { label: "None", detail: "" },
  ]);
  assert.equal(steps[0].dateKey, "2026-09-21");
  for (const step of steps.slice(1)) {
    assert.equal("dateKey" in step, false, `${step.label} kept a bad dateKey`);
  }
});

test("§2 MODEL an FAQ entry with no question is dropped, not rendered blank", () => {
  const faq = sanitizeFaq([
    { q: "How long is it?", a: "Six weeks." },
    { q: "   ", a: "An answer to nothing." },
    { q: "No answer yet", a: "" },
  ]);
  assert.deepEqual(faq.map((f) => f.q), ["How long is it?", "No answer yet"]);
});

test("§2 MODEL an unauthored page normalises to an empty one, and knows it is empty", () => {
  const page = emptyCoursePage("course1");
  assert.equal(page.id, "course1");
  assert.deepEqual(page.pitchBlocks, []);
  assert.deepEqual(page.weeklyThemes, []);
  assert.equal(page.sampleWeekNumber, null);
  assert.equal(page.coverImageUrl, null);
  assert.equal(page.themesSourceTemplateId, null);
  assert.equal(coursePageHasContent(page), false);
  assert.equal(
    coursePageHasContent(normalizeCoursePage("c", { headline: "Learn AI safety" })),
    true,
  );
});

test("§2 GUARD the sample week must name a week that could exist", () => {
  for (const bad of [0, -1, 61, "3", null, undefined, 1.5e9]) {
    assert.equal(
      normalizeCoursePage("c", { sampleWeekNumber: bad }).sampleWeekNumber,
      null,
      `${String(bad)} was accepted as a week number`,
    );
  }
  assert.equal(normalizeCoursePage("c", { sampleWeekNumber: 3 }).sampleWeekNumber, 3);
});

// ---------------------------------------------------------------------------
// §2c The fetcher returns less than it reads
// ---------------------------------------------------------------------------

/** The stored row, provenance pair and all, as the fetcher would find it. */
const STORED_PAGE = {
  headline: "Learn how AI could go wrong",
  pitchBlocks: [],
  whoItIsFor: "Any student.",
  weeklyThemes: [{ weekNumber: 1, title: "Week 1", blurb: "An intro." }],
  themesSourceTemplateId: "asf-autumn-2026__ab12cd34",
  themesSourceLabel: "Autumn 2026 (pilot, do not publish)",
};

function withAdminDb(stored) {
  globalThis.__TEST_ADMIN_DB__ = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: stored !== null, data: () => stored ?? {} }),
      }),
    }),
  };
}

test("§2c GUARD fetchCoursePage returns NO themesSourceLabel key at all", async () => {
  // The key, not the value. A renderer cannot print what is not there, and a
  // `{...page}` spread into a client component cannot carry it over either.
  // The stored label here is the failure this prevents: a run label an author
  // wrote for themselves, on a page for strangers.
  withAdminDb(STORED_PAGE);
  const page = await fetchCoursePage("course1");

  assert.equal("themesSourceLabel" in page, false);
  assert.equal("themesSourceTemplateId" in page, false);
  assert.equal(
    JSON.stringify(page).includes("do not publish"),
    false,
    "the staff-facing run label reached the public object",
  );

  // The copy still arrives. A stripper that ate the page would be noticed;
  // one that ate a field would not.
  assert.equal(page.headline, "Learn how AI could go wrong");
  assert.deepEqual(page.weeklyThemes.map((t) => t.weekNumber), [1]);
});

test("§2c GUARD the empty page and the no-database page are stripped too", async () => {
  // Three exits, one shape. The `!snap.exists` and `!db` branches build their
  // page from `emptyCoursePage`, which is a full CoursePageDoc, so a stripper
  // applied on only the found-document path would leak on the other two.
  withAdminDb(null);
  const missing = await fetchCoursePage("course1");
  assert.equal("themesSourceLabel" in missing, false);
  assert.equal(coursePageHasContent(missing), false);

  globalThis.__TEST_ADMIN_DB__ = null;
  const unconfigured = await fetchCoursePage("course1");
  assert.equal("themesSourceLabel" in unconfigured, false);
  assert.equal("themesSourceTemplateId" in unconfigured, false);
});

test("§2c MODEL toPublicCoursePage keeps everything else", () => {
  const full = normalizeCoursePage("c", STORED_PAGE);
  const publicPage = toPublicCoursePage(full);
  const dropped = Object.keys(full).filter((key) => !(key in publicPage));
  assert.deepEqual(dropped.sort(), ["themesSourceLabel", "themesSourceTemplateId"]);
});

// ---------------------------------------------------------------------------
// §2b Who may author a page
// ---------------------------------------------------------------------------

test("§2b GUARD a permission holder with no relationship to the course is refused", () => {
  const course = { authorUid: "author", collaboratorUids: ["collab"] };
  const drafter = (uid) => ({
    uid,
    role: "member",
    permissions: { draftCourse: true },
  });

  assert.equal(canAuthorCoursePage(drafter("stranger"), course), false);
  assert.equal(canAuthorCoursePage(drafter("author"), course), true);
  assert.equal(canAuthorCoursePage(drafter("collab"), course), true);
  // An admin needs no relationship, as everywhere else in this feature.
  assert.equal(
    canAuthorCoursePage({ uid: "a", role: "admin", permissions: {} }, course),
    true,
  );
  // And a collaborator who holds NO course permission is refused here, even
  // though the `courses` update rule would let them edit the course doc: this
  // document is public marketing copy.
  assert.equal(
    canAuthorCoursePage({ uid: "collab", role: "member", permissions: {} }, course),
    false,
  );
});

// ---------------------------------------------------------------------------
// §3 The cohort is absent, never null
// ---------------------------------------------------------------------------

test("§3 GUARD updateRun CLEARS the cohort with deleteField, never a stored null", () => {
  // A stored null fails `.get('cohort', {}).keys()` in the rules and wedges
  // every later non-admin edit of the run. Source-pinned because the symptom
  // appears on a later, unrelated write.
  const branch = /if \(patch\.cohort === null\) \{[\s\S]{0,240}?\n    \}/.exec(MUTATIONS);
  assert.ok(branch, "the cohort clear branch is no longer recognisable");
  assert.match(branch[0], /deleteField\(\)/);
  assert.equal(/out\.cohort = null/.test(MUTATIONS), false);
});

test("§3 MODEL the rules cap the cohort's KEY SET, which is also what refuses a null", () => {
  assert.match(
    RULES,
    /get\('cohort', \{\}\)\.keys\(\)\s*\n?\s*\.hasOnly\(\['term', 'year', 'number'\]\)/,
  );
  assert.match(RULES, /get\('startHereBlocks', \[\]\)\.size\(\) <= 20/);
});

test("§3 MODEL the rules cap and COURSE_FIELD_LIMITS agree about startHereBlocks", () => {
  assert.equal(COURSE_FIELD_LIMITS.maxStartHereBlocks, 20);
});

test("§3 MODEL a run with no cohort reads null, and a malformed one reads null too", () => {
  const base = {
    courseId: "c1",
    courseTitle: "AI Safety Fundamentals",
    label: "Autumn 2026",
    academicYear: "2026/27",
    status: "draft",
    startDate: "2026-10-26",
  };
  assert.equal(normalizeCourseRun("r1", base).cohort, null);
  for (const bad of [
    null,
    {},
    { term: "winter", year: 2026, number: 1 },
    { term: "autumn", year: "2026", number: 1 },
    { term: "autumn", year: 1999, number: 1 },
    { term: "autumn", year: 2026, number: 0 },
    { term: "autumn", year: 2026, number: 500 },
    [{ term: "autumn", year: 2026, number: 1 }],
  ]) {
    assert.equal(
      normalizeCourseRun("r1", { ...base, cohort: bad }).cohort,
      null,
      `${JSON.stringify(bad)} was accepted as a cohort`,
    );
  }
  assert.deepEqual(
    normalizeCourseRun("r1", {
      ...base,
      cohort: { term: "autumn", year: 2026, number: 2 },
    }).cohort,
    { term: "autumn", year: 2026, number: 2 },
  );
});

test("§3 MODEL startHereBlocks is sanitised and capped on the run", () => {
  const base = { courseId: "c1", status: "draft", startDate: "2026-10-26" };
  const run = normalizeCourseRun("r1", {
    ...base,
    startHereBlocks: [
      { id: "b1", type: "heading", text: "Start here", level: 2 },
      { id: "b2", type: "nonsense" },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, type: "divider" })),
    ],
  });
  assert.equal(run.startHereBlocks.length, COURSE_FIELD_LIMITS.maxStartHereBlocks);
  assert.equal(run.startHereBlocks[0].type, "heading");
  assert.equal(
    run.startHereBlocks.some((b) => b.type === "nonsense"),
    false,
  );
});

// ---------------------------------------------------------------------------
// §4 The one cohort formatter
// ---------------------------------------------------------------------------

test("§4 MODEL cohortLabel reads Autumn 2026, cohort 2", () => {
  assert.equal(
    cohortLabel({ cohort: { term: "autumn", year: 2026, number: 2 } }),
    "Autumn 2026, cohort 2",
  );
  assert.equal(
    cohortLabel({ cohort: { term: "spring", year: 2027, number: 1 } }),
    "Spring 2027, cohort 1",
  );
  assert.equal(
    cohortTermLabel({ cohort: { term: "summer", year: 2027, number: 3 } }),
    "Summer 2027",
  );
});

test("§4 GUARD the cohort number shows even when it is 1 (the documented decision)", () => {
  // The function sees ONE run and cannot know how many siblings exist. Hiding
  // ", cohort 1" would mean an already-sent decision email and a live page
  // disagreeing about the name of the same cohort the day a second one is
  // created. See the module comment.
  assert.match(
    cohortLabel({ cohort: { term: "autumn", year: 2026, number: 1 } }),
    /cohort 1$/,
  );
});

test("§4 GUARD a run with no cohort labels as EMPTY, never as its raw run label", () => {
  // `run.label` is free text an admin types and V3 stopped showing visitors.
  // Falling back to it here would put it back on every public surface at once.
  assert.equal(cohortLabel({ label: "Autumn 2026 (pilot, do not publish)" }), "");
  assert.equal(cohortLabel({ cohort: null, label: "internal" }), "");
  assert.equal(cohortLabel(null), "");
  assert.equal(cohortTermLabel(null), "");
});

test("§4 MODEL cohortError names what is wrong, with the same bounds the normaliser uses", () => {
  assert.equal(cohortError({ term: "autumn", year: 2026, number: 1 }), null);
  assert.match(cohortError(null) ?? "", /term, a year and a cohort number/);
  assert.match(cohortError({ term: "winter", year: 2026, number: 1 }) ?? "", /term/);
  assert.match(cohortError({ term: "autumn", year: 1200, number: 1 }) ?? "", /year/);
  assert.match(cohortError({ term: "autumn", year: 2026, number: 0 }) ?? "", /number/);

  // The two functions must agree, or a route accepts what a read then drops.
  for (const term of COHORT_TERMS) {
    for (const year of [COHORT_LIMITS.minYear, COHORT_LIMITS.maxYear]) {
      for (const number of [COHORT_LIMITS.minNumber, COHORT_LIMITS.maxNumber]) {
        const cohort = { term, year, number };
        assert.equal(cohortError(cohort), null);
        assert.deepEqual(normalizeCohort(cohort), cohort);
      }
    }
  }
});
