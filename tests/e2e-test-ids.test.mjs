/**
 * The test-id contract, in both directions (run under `npm test`: no browser,
 * no network, no credentials).
 *
 * WHY THIS EXISTS. A `data-testid` is the one kind of product code an
 * end-to-end suite is allowed to add, and it is also the one kind nobody ever
 * notices going wrong. A spec asks for an id no component carries and the
 * failure is a thirty-second locator timeout that reads like a slow page. A
 * component carries an id no spec asks for and nothing fails at all: the
 * attribute sits in the markup for a year after the spec that wanted it was
 * rewritten, and the next person to see it has no way to tell whether removing
 * it breaks a run.
 *
 * So both directions are checked, by walking:
 *
 *   - every `getByTestId("...")` in `tests/e2e/**` (the specs) and
 *     `scripts/e2e/lib/*.mjs` (the shared helpers);
 *   - every `data-testid="..."` in `src/**\/*.tsx`.
 *
 * An id asked for and not carried fails. An id carried and not asked for
 * fails. Both name the file and the line.
 *
 * LITERALS ONLY, on both sides. `getByTestId(`row-${id}`)` and
 * `data-testid={\`row-${id}\`}` cannot be matched to each other by reading the
 * source, so a template literal on either side would put a hole in the middle
 * of this guard exactly where a suite grows: one dynamic id, then five, then
 * the check covers the handful that were never interesting. A row that needs
 * to be picked out by its data belongs behind a literal id plus a `filter({
 * hasText })`, which is what `approvePendingApplicant` in
 * `scripts/e2e/lib/browser.mjs` does with the approval cards.
 *
 * The one shape that is allowed to be dynamic is a WRAPPER that takes an id as
 * a parameter, and only when it is declared in `DYNAMIC_LOCATORS` with the
 * literal ids it can be called with, and only while each of those ids is ALSO
 * asked for literally somewhere in the same spec file. That last condition is
 * the teeth: the declaration is a note about where a locator is written, never
 * permission for an id this guard cannot see. Reported, not skipped, is the
 * house rule; this is the reporting.
 *
 * THE SHAPE IS PART OF THE CONTRACT: `<area>-<thing>`, kebab-case. Not
 * decoration. The ids live in product markup that outlives any one spec, so
 * they have to say which surface they belong to when read cold, months later,
 * by somebody deciding whether a component can be deleted.
 *
 * WHAT IT CANNOT SEE. Whether the id is on the RIGHT element. A spec that
 * finds `rsvp-submit` on a heading rather than a button still passes here and
 * fails in the browser, which is the correct place for that failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "src");
const SPECS_DIR = join(REPO_ROOT, "tests", "e2e");
const HELPERS_DIR = join(REPO_ROOT, "scripts", "e2e", "lib");
/** Trees searched for a consumer that put itself somewhere unscanned. */
const HARNESS_ROOTS = [join(REPO_ROOT, "scripts"), join(REPO_ROOT, "tests")];

/** `<area>-<thing>`: lowercase, digits allowed, at least one hyphen. */
const ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

const rel = (path) => relative(REPO_ROOT, path).split("\\").join("/");

function walk(dir, ends, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
      walk(path, ends, out);
    } else if (ends.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Source with comment CONTENT blanked out but every newline kept, so a line
 * number in a failure message is still the line number in the editor.
 *
 * Comments are blanked rather than left alone because this file's own header
 * quotes both spellings it bans, and a guard that fails its own documentation
 * teaches the next editor to delete the documentation.
 */
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (match) => match.replace(/[^\n]/g, " "));
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

/* -------------------------------------------------------------------------
 * The two sides
 * ---------------------------------------------------------------------- */

/** Every `getByTestId(...)` call site in the specs and the shared helpers. */
function consumers() {
  const files = [...walk(SPECS_DIR, [".mjs"]), ...walk(HELPERS_DIR, [".mjs"])];
  const sites = [];
  for (const file of files) {
    const source = blankComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/getByTestId\(\s*([^)]*?)\s*\)/g)) {
      const arg = match[1];
      const literal = /^(["'])((?:(?!\1).)*)\1$/.exec(arg);
      sites.push({
        file: rel(file),
        line: lineOf(source, match.index),
        id: literal ? literal[2] : null,
        raw: arg,
      });
    }
  }
  return sites;
}

/** Every `data-testid` attribute in the product's components. */
function carriers() {
  const sites = [];
  for (const file of walk(SRC_DIR, [".tsx"])) {
    const source = blankComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/data-testid\s*=\s*([^\s>]+)/g)) {
      const raw = match[1];
      // Both accepted spellings: the bare attribute and the braced string.
      const literal =
        /^(["'])((?:(?!\1).)*)\1$/.exec(raw) ??
        /^\{\s*(["'])((?:(?!\1).)*)\1\s*\}$/.exec(raw);
      sites.push({
        file: rel(file),
        line: lineOf(source, match.index),
        id: literal ? literal[2] : null,
        raw,
      });
    }
  }
  return sites;
}

/**
 * The wrappers allowed to take an id as a parameter, with the literal ids each
 * one is called with and why the wrapper exists. Checked in FOUR directions: a
 * dynamic call site with no entry fails, an entry matching no call site fails,
 * an id an entry names that is not also asked for literally in the same file
 * fails, and every CALL of the wrapper must hand it one of the literal ids the
 * entry declares.
 *
 * That last one is the point of `wrapper` and `idArgIndex`. Without reading the
 * call sites, the exception would be a hole exactly the size of the wrapper:
 * `measure(page, "rsvp-typo")` would ask for an id nothing carries, and neither
 * cross-check below could see it, because the only `getByTestId` in that path
 * is inside the wrapper and is already excused. The failure would come back as
 * a thirty-second locator timeout in a browser run, which is the thing this
 * whole guard exists to move offline.
 *
 * Keyed by file and by the ARGUMENT TEXT rather than by line, so an entry
 * survives the spec being edited above it. There is no wildcard.
 */
const DYNAMIC_LOCATORS = [
  {
    file: "tests/e2e/events-rsvp.spec.mjs",
    arg: "testId",
    /** The function whose call sites carry the id, and where in its arguments. */
    wrapper: "measure",
    idArgIndex: 1,
    ids: ["rsvp-submit"],
    reason:
      "`measure(page, testId)` takes the mobile-baseline measurements (bounding box, " +
      "elementFromPoint, document scroll width) off one control, so the two rules are " +
      "measured the same way each time. The only id it is called with is asked for " +
      "literally twice more in the same file, so nothing here is invisible to the " +
      "cross-check below.",
  },
  {
    file: "tests/e2e/member-journey.spec.mjs",
    arg: "testId",
    wrapper: "bothPickersShow",
    idArgIndex: 1,
    ids: ["course-take-place", "course-change-session", "dropout-reveal"],
    reason:
      "`bothPickersShow(pg, testId)` counts an id to two before the spec touches it: the " +
      "public course page mounts CourseCTA twice, each with its own GroupPicker and its " +
      "own fetch, so `.first()` only means the hero once both have rendered. All three " +
      "ids it is called with are asked for literally in the same file.",
  },
];

const CONSUMERS = consumers();
const CARRIERS = carriers();

/**
 * Every call of `name(` in one file, with its arguments split at top-level
 * commas. Deliberately a small hand parser rather than a regular expression:
 * an argument can itself be a call (`measure(await page(), "rsvp-submit")`) and
 * a regular expression stopping at the first `)` would read the wrong one.
 *
 * The wrapper's own DEFINITION matches too (`async function measure(page,
 * testId)`), which is why the caller skips a site whose id argument is the
 * parameter name the entry declares.
 */
function callsTo(source, name) {
  const calls = [];
  const opener = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const match of source.matchAll(opener)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    let current = "";
    const args = [];
    let i = start;
    for (; i < source.length && depth > 0; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") {
          current += ch + (source[i + 1] ?? "");
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
        current += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth === 1 && ch === ",") {
        args.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    args.push(current.trim());
    calls.push({ line: lineOf(source, match.index), args });
  }
  return calls;
}

/* -------------------------------------------------------------------------
 * The checks
 * ---------------------------------------------------------------------- */

test("the walk finds both sides of the contract", () => {
  // A guard over two empty lists passes while proving nothing, and both these
  // trees are young enough to be moved by somebody tidying up.
  assert.ok(
    existsSync(SPECS_DIR) && existsSync(HELPERS_DIR),
    `${rel(SPECS_DIR)} and ${rel(HELPERS_DIR)} must both exist: they are where the ids are ` +
      "asked for.",
  );
  assert.ok(
    walk(SRC_DIR, [".tsx"]).length > 100,
    "the src walk found almost no .tsx files, so the carrier side is not being read.",
  );
  assert.ok(
    CONSUMERS.length > 0,
    "no getByTestId call was found in the specs or the helpers. If the suite really uses " +
      "none, delete this guard rather than leaving it green over nothing.",
  );
});

test("every id a spec asks for is a literal string, or a declared wrapper", () => {
  const problems = [];
  const matched = new Set();
  for (const site of CONSUMERS) {
    if (site.id !== null) continue;
    const entry = DYNAMIC_LOCATORS.find((d) => d.file === site.file && d.arg === site.raw);
    if (!entry) {
      problems.push(
        `${site.file}:${site.line}: getByTestId(${site.raw}) - ids must be literal. A ` +
          "computed id cannot be matched to the component that carries it by reading the " +
          "source, so this guard would stop being able to see either side. Use a literal " +
          "id and narrow with filter({ hasText }) or .nth(), or declare the wrapper in " +
          "DYNAMIC_LOCATORS with the literal ids it is called with.",
      );
      continue;
    }
    matched.add(entry);
    if (entry.reason.length < 40) {
      problems.push(`${site.file}: the DYNAMIC_LOCATORS entry for ${entry.arg} needs a reason.`);
    }
    // The condition that keeps the declaration honest: every id the wrapper can
    // be handed is still asked for literally in this same file, so the two
    // cross-checks below still see it.
    const literalsHere = new Set(
      CONSUMERS.filter((c) => c.file === site.file && c.id).map((c) => c.id),
    );
    for (const id of entry.ids) {
      if (!literalsHere.has(id)) {
        problems.push(
          `${site.file}: DYNAMIC_LOCATORS names ${JSON.stringify(id)} for ${entry.arg}, but ` +
            "that id is not asked for literally anywhere in this file, so nothing else in " +
            "this guard can see it. Add the literal locator, or drop the id from the entry.",
        );
      }
    }
  }
  for (const entry of DYNAMIC_LOCATORS) {
    if (!matched.has(entry)) {
      problems.push(
        `DYNAMIC_LOCATORS has an entry for ${entry.file} (${entry.arg}) that matches no ` +
          "getByTestId call. The wrapper was rewritten or removed: delete the entry.",
      );
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("every call of a declared wrapper hands it a literal id it declares", () => {
  const problems = [];
  for (const entry of DYNAMIC_LOCATORS) {
    const path = join(REPO_ROOT, entry.file);
    if (!existsSync(path)) {
      problems.push(
        `DYNAMIC_LOCATORS names ${entry.file}, which does not exist. The spec was renamed ` +
          "or deleted: delete the entry with it.",
      );
      continue;
    }
    const source = blankComments(readFileSync(path, "utf8"));
    const declared = new Set(entry.ids);
    let realCalls = 0;
    for (const call of callsTo(source, entry.wrapper)) {
      const arg = call.args[entry.idArgIndex];
      // The wrapper's own definition reads as a call of itself, and its id
      // argument is the parameter name the entry declares. So does an internal
      // pass-through, whose own getByTestId is the excused one.
      if (arg === undefined || arg === entry.arg) continue;
      realCalls += 1;
      const literal = /^(["'])((?:(?!\1).)*)\1$/.exec(arg);
      if (!literal) {
        problems.push(
          `${entry.file}:${call.line}: ${entry.wrapper}(...) is handed ${arg} as its id, which ` +
            "is not a literal. The wrapper is excused from the literal rule; its CALLERS are " +
            "not, because this guard can only see the id where it is written down.",
        );
        continue;
      }
      if (!declared.has(literal[2])) {
        problems.push(
          `${entry.file}:${call.line}: ${entry.wrapper}(...) is handed ` +
            `${JSON.stringify(literal[2])}, which the DYNAMIC_LOCATORS entry does not declare. ` +
            "Add it to the entry's ids (and ask for it literally in this file too), or fix " +
            "the call. Unlisted, it is an id no cross-check below can see.",
        );
      }
    }
    if (realCalls === 0) {
      problems.push(
        `${entry.file}: DYNAMIC_LOCATORS declares the wrapper ${JSON.stringify(entry.wrapper)}, ` +
          "but nothing in the file calls it. The wrapper was renamed or its callers went: " +
          "update the entry or delete it.",
      );
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("every id a component carries is a literal string", () => {
  const dynamic = CARRIERS.filter((site) => site.id === null).map(
    (site) =>
      `${site.file}:${site.line}: data-testid=${site.raw} - ids must be literal. A template ` +
      "literal or an expression here cannot be matched against the specs, so the id is " +
      "invisible to this guard in both directions.",
  );
  assert.deepEqual(dynamic, [], `\n${dynamic.join("\n")}\n`);
});

test("every id a spec asks for is carried by a component", () => {
  const carried = new Set(CARRIERS.filter((site) => site.id).map((site) => site.id));
  const missing = CONSUMERS.filter((site) => site.id && !carried.has(site.id)).map(
    (site) =>
      `${site.file}:${site.line}: getByTestId(${JSON.stringify(site.id)}) has no ` +
      "data-testid anywhere in src. Either the attribute was never added, or it was " +
      "renamed and the spec was not. In a run this is a thirty-second timeout that reads " +
      "like a slow page.",
  );
  assert.deepEqual(missing, [], `\n${missing.join("\n")}\n`);
});

test("every id a component carries is asked for by a spec or a helper", () => {
  const asked = new Set(CONSUMERS.filter((site) => site.id).map((site) => site.id));
  const unused = CARRIERS.filter((site) => site.id && !asked.has(site.id)).map(
    (site) =>
      `${site.file}:${site.line}: data-testid=${JSON.stringify(site.id)} is carried by the ` +
      "product and asked for by nothing. Delete it, or add the spec that needs it. An id " +
      "no spec uses is markup nobody can safely remove later.",
  );
  assert.deepEqual(unused, [], `\n${unused.join("\n")}\n`);
});

test("every id is kebab-case and says which area it belongs to", () => {
  const wrong = [];
  for (const site of [...CONSUMERS, ...CARRIERS]) {
    if (site.id && !ID_SHAPE.test(site.id)) {
      wrong.push(
        `${site.file}:${site.line}: ${JSON.stringify(site.id)} is not <area>-<thing> in ` +
          "kebab-case. These ids live in product markup that outlives the spec, so they " +
          "have to name their surface when read cold.",
      );
    }
  }
  assert.deepEqual(wrong, [], `\n${wrong.join("\n")}\n`);
});

test("no test-id consumer hides outside the trees this guard reads", () => {
  // The dodge this closes: a locator in a file the walk above does not visit
  // (a fixture module, a new helper directory), which would let an id go
  // unmatched in both directions while every check here stayed green.
  const scanned = new Set([
    ...walk(SPECS_DIR, [".mjs"]).map(rel),
    ...walk(HELPERS_DIR, [".mjs"]).map(rel),
    // This file, which names the call it is looking for in every failure
    // message it can print.
    rel(fileURLToPath(import.meta.url)),
  ]);
  const strays = [];
  for (const root of HARNESS_ROOTS) {
    for (const file of walk(root, [".mjs", ".js", ".ts"])) {
      if (scanned.has(rel(file))) continue;
      const source = blankComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/getByTestId\(/g)) {
        strays.push(
          `${rel(file)}:${lineOf(source, match.index)}: getByTestId here is invisible to the ` +
            "test-id guard, which reads tests/e2e and scripts/e2e/lib. Move the locator into " +
            "a spec or a shared helper, or widen the walk deliberately.",
        );
      }
    }
  }
  assert.deepEqual(strays, [], `\n${strays.join("\n")}\n`);
});
