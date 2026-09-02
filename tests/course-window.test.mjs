/**
 * Unit tests for the APPLICATION WINDOW: the one predicate that decides
 * whether a course run is taking applications.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * The applicant-facing blocker it closes was a DISAGREEMENT, not a missing
 * check. The apply route always enforced `applicationsOpenAt` /
 * `applicationsCloseAt`; every discovery surface (catalogue card, course page
 * CTA, apply page) keyed on `run.status === "applications-open"` and nothing
 * else. So a run left open past its deadline advertised an open application,
 * rendered the full form, and refused the POST once the applicant had written
 * the whole thing. `src/lib/courses/window.ts` is now the single predicate
 * both sides call, and this file is what stops the two drifting apart again.
 *
 * Three properties are worth naming, because each one is a decision rather
 * than an obvious consequence:
 *
 *  1. **Status beats the dates.** A run moved to `applications-closed` early
 *     is closed even if `applicationsCloseAt` is still in the future. The
 *     status is an admin's deliberate act; the date is a schedule.
 *  2. **A null bound is unbounded, never closed.** `applicationsCloseAt:
 *     null` means "open until someone closes it". Reading null as "no window,
 *     therefore shut" would silently close every rolling run on the site.
 *  3. **Both bounds are inclusive.** Exactly at the open instant you are in;
 *     exactly at the close instant you are still in. This mirrors the strict
 *     `<` / `>` comparisons the apply route has always used, so adopting the
 *     shared predicate changed nobody's answer by a millisecond. The exact
 *     boundary instants are tested on both sides.
 *
 * ## Why the loader dance
 *
 * Same root cause as `course-offer.test.mjs`: this repo's Node predates the
 * v22.18 that strips TypeScript natively, so the module graph is transpiled in
 * memory with the `typescript` devDependency `npx tsc --noEmit` already uses.
 * The transpile path is taken unconditionally rather than as a fallback, so
 * the behaviour is identical on every Node the team runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const WINDOW_MODULE = join(SRC, "lib", "courses", "window.ts");

/**
 * Every module specifier in transpiled output: `from "x"`, `import "x"` and
 * `import("x")`, in either quote style. Deliberately a regex over the OUTPUT
 * rather than a TypeScript AST walk, because by then the type-only imports are
 * already gone and what is left is plain ES module syntax.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. The window module imports nothing
 * but `COURSE_TZ` from `weekPlan.ts` (which is itself dependency-free by
 * design) and a TYPE from the Firestore courses module, which the transpiler
 * erases, so in practice nothing here is reached. The map is kept because
 * `weekPlan.ts` is loaded for real and a future import of it must not be able
 * to drag a `server-only` module into a unit test unnoticed.
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

/** file path (or stub key) → data: URL of its module source. Memoised. */
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
      // A package. `import.meta.resolve` is the runtime's own resolver, so this
      // is exactly the file the app would have loaded.
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

async function loadTs(file) {
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
  return import(await transpileToDataUrl(file));
}

const {
  applicationWindow,
  formatWindowDate,
  formatWindowDeadline,
  formatPastWindowDate,
  formatRunStart,
  formatRunStartShort,
} = await loadTs(WINDOW_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sun 18 Oct 2026, 23:59:00 London (BST, UTC+1): the real autumn deadline. */
const CLOSE = new Date("2026-10-18T22:59:00Z");
/** Mon 21 Sep 2026, 09:00 London: the real autumn opening. */
const OPEN = new Date("2026-09-21T08:00:00Z");

const INSIDE = new Date("2026-10-01T12:00:00Z");
const BEFORE = new Date("2026-09-01T12:00:00Z");
const AFTER = new Date("2026-11-01T12:00:00Z");

/** Every run status, so the matrix below cannot silently miss a new one. */
const STATUSES = [
  "draft",
  "applications-open",
  "applications-closed",
  "running",
  "completed",
  "cancelled",
];

function run(overrides = {}) {
  return {
    status: "applications-open",
    archived: false,
    applicationsOpenAt: OPEN,
    applicationsCloseAt: CLOSE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The states, one per status
// ---------------------------------------------------------------------------

test("a draft run is inactive, whatever its dates say", () => {
  // Unfinished authoring is not a public state, so it gets its own bucket
  // rather than "closed". The route answers it with the sentence it gives a
  // run that was never open, and public fetchers drop it entirely.
  assert.equal(applicationWindow(run({ status: "draft" }), INSIDE).state, "inactive");
  assert.equal(
    applicationWindow(
      run({ status: "draft", applicationsOpenAt: null, applicationsCloseAt: null }),
      INSIDE,
    ).state,
    "inactive",
  );
});

test("an archived run is inactive even while its status still says open", () => {
  // `archived` is ORTHOGONAL to status and is what the destroy cascade sets in
  // its opening transaction. If this stopped closing the window, an
  // application could land on a run whose rows are already being deleted.
  const found = applicationWindow(run({ archived: true }), INSIDE);
  assert.equal(found.state, "inactive");
  // Archiving a DRAFT is still inactive, not something else.
  assert.equal(
    applicationWindow(run({ archived: true, status: "draft" }), INSIDE).state,
    "inactive",
  );
});

test("every status other than applications-open and draft is closed", () => {
  for (const status of ["applications-closed", "running", "completed", "cancelled"]) {
    assert.equal(
      applicationWindow(run({ status }), INSIDE).state,
      "closed",
      `${status} should be closed`,
    );
  }
});

test("status beats the dates: closed early stays closed inside the window", () => {
  // An admin flipping the run to `applications-closed` before the deadline is
  // a deliberate act. Reading the dates first would reopen it under them.
  const found = applicationWindow(run({ status: "applications-closed" }), INSIDE);
  assert.equal(found.state, "closed");
  // …and the bounds still come back, so the closed card can name the deadline
  // that was advertised.
  assert.equal(found.closesAt, CLOSE);
});

test("the status matrix is exhaustive over CourseRunStatus", () => {
  // A new status added to the union without a decision here would fall into
  // the `closed` branch by default. That is the safe default, but it should be
  // a choice: this test fails loudly if the union grows.
  assert.equal(STATUSES.length, 6);
  const states = STATUSES.map((status) => applicationWindow(run({ status }), INSIDE).state);
  assert.deepEqual(states, [
    "inactive", // draft
    "open", // applications-open
    "closed", // applications-closed
    "closed", // running
    "closed", // completed
    "closed", // cancelled
  ]);
});

// ---------------------------------------------------------------------------
// applications-open, and the dates around it
// ---------------------------------------------------------------------------

test("applications-open inside both bounds is open", () => {
  const found = applicationWindow(run(), INSIDE);
  assert.equal(found.state, "open");
  assert.equal(found.opensAt, OPEN);
  assert.equal(found.closesAt, CLOSE);
});

test("applications-open before applicationsOpenAt is not-yet, not open", () => {
  // The mirror of the deadline bug: this used to render an Apply button whose
  // POST answered "Applications for this run haven't opened yet."
  const found = applicationWindow(run(), BEFORE);
  assert.equal(found.state, "not-yet");
  assert.equal(found.opensAt, OPEN);
});

test("applications-open after applicationsCloseAt is closed (THE BLOCKER)", () => {
  // The whole reason this module exists. Status still says open; the deadline
  // has passed; every surface must now agree with the route and say so.
  const found = applicationWindow(run(), AFTER);
  assert.equal(found.state, "closed");
  assert.equal(found.closesAt, CLOSE);
});

// ---------------------------------------------------------------------------
// Null bounds
// ---------------------------------------------------------------------------

test("a null close date is unbounded, not closed", () => {
  const rolling = run({ applicationsCloseAt: null });
  assert.equal(applicationWindow(rolling, INSIDE).state, "open");
  // Far into the future, still open, because there is no automatic deadline.
  assert.equal(applicationWindow(rolling, new Date("2030-01-01T00:00:00Z")).state, "open");
  assert.equal(applicationWindow(rolling, INSIDE).closesAt, null);
});

test("a null open date means open from the moment the status flips", () => {
  const rolling = run({ applicationsOpenAt: null });
  assert.equal(applicationWindow(rolling, BEFORE).state, "open");
  assert.equal(applicationWindow(rolling, INSIDE).state, "open");
  // The close bound still applies on its own.
  assert.equal(applicationWindow(rolling, AFTER).state, "closed");
  assert.equal(applicationWindow(rolling, INSIDE).opensAt, null);
});

test("both bounds null is open for as long as the status says so", () => {
  const unbounded = run({ applicationsOpenAt: null, applicationsCloseAt: null });
  for (const now of [BEFORE, INSIDE, AFTER]) {
    assert.equal(applicationWindow(unbounded, now).state, "open");
  }
  // And an admin closing it by status is the only way it ever shuts.
  assert.equal(
    applicationWindow({ ...unbounded, status: "applications-closed" }, INSIDE).state,
    "closed",
  );
});

// ---------------------------------------------------------------------------
// The exact boundary instants
// ---------------------------------------------------------------------------

test("the open instant itself is INSIDE the window", () => {
  assert.equal(applicationWindow(run(), new Date(OPEN.getTime())).state, "open");
  // One millisecond earlier is not.
  assert.equal(
    applicationWindow(run(), new Date(OPEN.getTime() - 1)).state,
    "not-yet",
  );
  // One millisecond later plainly is.
  assert.equal(applicationWindow(run(), new Date(OPEN.getTime() + 1)).state, "open");
});

test("the close instant itself is INSIDE the window", () => {
  // "Closes at 23:59" means 23:59:00.000 is still accepted, which is what a
  // person reads it as, and what the apply route's `>` comparison has always
  // done. The first refused instant is one millisecond later.
  assert.equal(applicationWindow(run(), new Date(CLOSE.getTime())).state, "open");
  assert.equal(applicationWindow(run(), new Date(CLOSE.getTime() - 1)).state, "open");
  assert.equal(applicationWindow(run(), new Date(CLOSE.getTime() + 1)).state, "closed");
});

test("a window whose bounds are the same instant is open at exactly that instant", () => {
  // Degenerate, but it falls out of two inclusive comparisons and a surface
  // must not crash or contradict itself on it.
  const pin = new Date("2026-10-05T10:00:00Z");
  const knife = run({ applicationsOpenAt: pin, applicationsCloseAt: pin });
  assert.equal(applicationWindow(knife, new Date(pin.getTime())).state, "open");
  assert.equal(applicationWindow(knife, new Date(pin.getTime() - 1)).state, "not-yet");
  assert.equal(applicationWindow(knife, new Date(pin.getTime() + 1)).state, "closed");
});

test("a backwards window (close before open) reports not-yet, then closed", () => {
  // Authoring can produce this. `not-yet` wins while before the open date
  // because that is the check that runs first; after it, the passed deadline
  // closes it. Never `open`, which is the property that matters.
  const backwards = run({
    applicationsOpenAt: new Date("2026-11-01T00:00:00Z"),
    applicationsCloseAt: new Date("2026-10-01T00:00:00Z"),
  });
  assert.equal(applicationWindow(backwards, INSIDE).state, "not-yet");
  assert.equal(applicationWindow(backwards, new Date("2026-12-01T00:00:00Z")).state, "closed");
});

// ---------------------------------------------------------------------------
// The bounds always come back
// ---------------------------------------------------------------------------

test("opensAt and closesAt are echoed back in EVERY state", () => {
  // Each card that says "closed" has to be able to name the date it closed on,
  // and the not-yet card has to name the date it opens. A predicate that only
  // returned the dates in the state that used them would send every other
  // surface back to the run doc.
  for (const status of STATUSES) {
    for (const now of [BEFORE, INSIDE, AFTER]) {
      const found = applicationWindow(run({ status }), now);
      assert.equal(found.opensAt, OPEN, `${status} lost opensAt`);
      assert.equal(found.closesAt, CLOSE, `${status} lost closesAt`);
    }
  }
  const archived = applicationWindow(run({ archived: true }), INSIDE);
  assert.equal(archived.opensAt, OPEN);
  assert.equal(archived.closesAt, CLOSE);
});

test("undefined bounds normalise to null rather than leaking through", () => {
  // Firestore normalisers hand back null, but a hand-built object (or a
  // partially migrated doc) can hand back undefined, and `undefined` in a
  // rendered date line is a crash waiting to happen.
  const found = applicationWindow(
    { status: "applications-open", archived: false },
    INSIDE,
  );
  assert.equal(found.state, "open");
  assert.equal(found.opensAt, null);
  assert.equal(found.closesAt, null);
});

// ---------------------------------------------------------------------------
// Date labels
// ---------------------------------------------------------------------------

test("formatWindowDate renders the London calendar day, not the viewer's", () => {
  // 23:59 BST on Sun 18 Oct is 22:59 UTC the same day. A viewer-zone format
  // would be right here by luck; the case that matters is the one below.
  assert.equal(formatWindowDate(CLOSE), "Sun 18 Oct");
  // 00:30 BST on Mon 19 Oct is 23:30 UTC on SUNDAY the 18th. Formatting in UTC
  // would name the wrong day, and a deadline named a day early is the exact
  // failure this whole branch is about.
  assert.equal(formatWindowDate(new Date("2026-10-18T23:30:00Z")), "Mon 19 Oct");
});

test("formatWindowDeadline carries the time of day in 24-hour London clock", () => {
  assert.equal(formatWindowDeadline(CLOSE), "Sun 18 Oct, 23:59");
  // Midnight reads as 00:00, never 24:00, which is hourCycle h23 doing that.
  assert.equal(
    formatWindowDeadline(new Date("2026-01-05T00:00:00Z")),
    "Mon 5 Jan, 00:00",
  );
});

test("formatPastWindowDate carries the YEAR, which a passed deadline needs", () => {
  // A future deadline is always the next one of its kind, so "Sun 18 Oct" is
  // unambiguous. A PAST one may belong to a run from a previous academic
  // year, and the same label without a year reads as "you missed it by a
  // fortnight" rather than "that cohort ran last autumn". The apply page and
  // the course CTA both switch to this formatter once the window is closed.
  // Intl punctuates a weekday-plus-year date with a comma, which is correct
  // en-GB and reads fine mid-sentence ("closed on Sun, 18 Oct 2026").
  assert.equal(formatPastWindowDate(CLOSE), "Sun, 18 Oct 2026");
  assert.equal(
    formatPastWindowDate(new Date("2024-10-20T22:59:00Z")),
    "Sun, 20 Oct 2024",
  );
  // Still London, not UTC: 23:30 UTC on the 18th is 00:30 on the 19th here.
  assert.equal(
    formatPastWindowDate(new Date("2026-10-18T23:30:00Z")),
    "Mon, 19 Oct 2026",
  );
});

test("formatRunStart and formatRunStartShort read a CIVIL date safely", () => {
  // Noon UTC internally, so neither the March nor the October clock change can
  // shift the calendar day. 2026-10-26 is the Monday after the autumn change.
  assert.equal(formatRunStart("2026-10-26"), "Monday 26 October");
  assert.equal(formatRunStartShort("2026-10-26"), "Mon 26 Oct");
  // A day inside BST, and a day inside GMT, both land on themselves.
  assert.equal(formatRunStartShort("2026-06-01"), "Mon 1 Jun");
  assert.equal(formatRunStartShort("2026-12-25"), "Fri 25 Dec");
});

test("a missing or malformed start date formats to undefined, never a crash", () => {
  // A half-authored draft run legitimately has no start date, and the public
  // course page renders while it is in that state.
  for (const bad of ["", "not-a-date", "2026-13-01", "26-10-2026", "2026-10-26T00:00:00Z"]) {
    assert.equal(formatRunStart(bad), undefined, `formatRunStart(${bad})`);
    assert.equal(formatRunStartShort(bad), undefined, `formatRunStartShort(${bad})`);
  }
});

// ---------------------------------------------------------------------------
// The predicate is genuinely shared
// ---------------------------------------------------------------------------

test("the apply route and the public fetchers call THIS module, not their own copy", () => {
  // The bug was a second implementation, so the fix is only real while there
  // is exactly one. Asserted by reading the sources: a route that reintroduces
  // its own date comparison fails here.
  const APPLY_ROUTE = readFileSync(
    join(SRC, "app", "api", "courses", "runs", "[runId]", "apply", "route.ts"),
    "utf8",
  );
  const FETCH_COURSES = readFileSync(
    join(SRC, "features", "courses", "fetchCourses.ts"),
    "utf8",
  );

  assert.match(APPLY_ROUTE, /from "@\/lib\/courses\/window"/);
  assert.match(APPLY_ROUTE, /applicationWindow\(run, now\)/);
  assert.match(FETCH_COURSES, /from "@\/lib\/courses\/window"/);
  assert.match(FETCH_COURSES, /applicationWindow\(/);

  // No hand-rolled bound comparison left anywhere in either file.
  assert.doesNotMatch(APPLY_ROUTE, /applicationsCloseAt\.getTime\(\)/);
  assert.doesNotMatch(APPLY_ROUTE, /applicationsOpenAt\.getTime\(\)/);
  assert.doesNotMatch(FETCH_COURSES, /status !== "applications-open"/);
});
