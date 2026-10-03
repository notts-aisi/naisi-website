/**
 * What CodeQL is told to leave out is test files, and only test files.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * CodeQL's results are required before a merge, so `paths-ignore` in
 * `.github/codeql/codeql-config.yml` is a list of code that no longer has to
 * answer to it. It exists so that a test, which builds hostile input and fakes
 * the database on purpose, cannot hold up its own pull request. It must not
 * become the place a real finding goes to be quiet: a path added there to make
 * an alert disappear takes that code out of the analysis for good.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(REPO_ROOT, ".github/codeql/codeql-config.yml"), "utf8");

/** The entries under `paths-ignore:`, as written. */
function ignored() {
  const block = config.match(/\npaths-ignore:\n((?: {2}- .+\n?)+)/);
  assert.ok(block, "the config has no paths-ignore list this reader could find");
  return block[1].split("\n").filter(Boolean).map((line) => line.replace(/^ {2}- /, "").trim());
}

/** Each ignored tree, with why everything under it is a test. */
const TEST_TREES = {
  "tests/**": "the `npm test` suites, their helpers and registries, and the browser specs under tests/e2e",
  "scripts/e2e/tests/**": "the fetch batteries `npm run e2e` runs",
  "scripts/rules-tests/tests/**": "the Firestore and Storage rules suites",
};

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

test("the ignored paths are exactly the registered test trees", () => {
  assert.deepEqual(
    ignored().sort(),
    Object.keys(TEST_TREES).sort(),
    "Code was added to, or removed from, the paths CodeQL skips. Only a directory that holds nothing " +
      "but tests belongs there, and it goes in TEST_TREES with the reason. A finding in shipped code is " +
      "fixed, or dismissed on the alert with a reason, never ignored by path.",
  );
});

test("every ignored tree exists and ends in a wildcard over a directory", () => {
  for (const pattern of Object.keys(TEST_TREES)) {
    assert.match(pattern, /^[a-z0-9/_-]+\/\*\*$/i, `${pattern} is not a whole directory`);
    assert.ok(existsSync(join(REPO_ROOT, pattern.replace(/\/\*\*$/, ""))), `${pattern} names a directory that does not exist`);
  }
});

test("nothing under src is ignored, and nothing under src is built from an ignored tree", () => {
  for (const pattern of ignored()) {
    assert.ok(!pattern.startsWith("src"), `${pattern} takes application code out of the analysis`);
  }
  // The app is what is under src. If a module there imported from a test
  // tree, that code would ship while hiding from the scan, so no import under
  // src may climb out to `tests/` or `scripts/`.
  const offenders = [];
  let read = 0;
  for (const file of walk(join(REPO_ROOT, "src"))) {
    read += 1;
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g)) {
      if (specifier && /(^|\/)(tests|scripts)\//.test(specifier) && specifier.startsWith(".")) {
        offenders.push(`${file.slice(REPO_ROOT.length + 1)} imports ${specifier}`);
      }
    }
  }
  assert.ok(read > 100, "the walk read almost nothing under src");
  assert.deepEqual(offenders, []);
});

test("the harness that runs with a cloud identity stays in the analysis", () => {
  for (const path of ["scripts/e2e/lib", "scripts/e2e-fixtures", "scripts/run-e2e.mjs", "scripts/ci"]) {
    assert.ok(existsSync(join(REPO_ROOT, path)), `${path} has moved: update this list`);
    for (const pattern of ignored()) {
      const tree = pattern.replace(/\*\*$/, "");
      assert.ok(!`${path}/`.startsWith(tree), `${path} is skipped by ${pattern}`);
    }
  }
});

test("the workflow uses the config, for every language it analyses", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/codeql.yml"), "utf8");
  const inits = [...workflow.matchAll(/uses: github\/codeql-action\/init@[^\n]+\n((?: {8,}.*\n)+)/g)];
  assert.ok(inits.length > 0, "no CodeQL init step found");
  for (const [, block] of inits) {
    assert.match(block, /config-file: \.\/\.github\/codeql\/codeql-config\.yml/);
  }
});
