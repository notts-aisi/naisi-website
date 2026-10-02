/**
 * A dependency held back from an update says why, and what lifts the hold.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * An `ignore` entry in `.github/dependabot.yml` stops Dependabot proposing a
 * version. That is right when the version cannot be taken yet (it needs a
 * newer Node, or a plugin that has not caught up), and without the entry the
 * same pull request is reopened every week and fails the same way every week.
 * It is wrong when nobody remembers why it is there: a hold with no reason is
 * how a dependency ends up three majors behind. So every entry carries a WHY
 * and a LIFT WHEN, and an entry for a package the manifest no longer has is
 * a hold on nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(join(REPO_ROOT, ".github/dependabot.yml"), "utf8").split("\n");

/** Every `ignore` entry, with the directory of its block and the comment written above it. */
function holds() {
  const found = [];
  let directory = null;
  for (let i = 0; i < lines.length; i += 1) {
    const dir = lines[i].match(/^ {4}directory: (\S+)/);
    if (dir) directory = dir[1];
    const entry = lines[i].match(/^ {6}- dependency-name: "?([^"\s]+)"?\s*$/);
    if (!entry) continue;
    const comment = [];
    for (let j = i - 1; j >= 0 && /^ {6}#/.test(lines[j]); j -= 1) comment.unshift(lines[j].replace(/^ {6}# ?/, ""));
    found.push({ name: entry[1], directory, comment: comment.join(" "), line: i + 1, next: lines[i + 1] ?? "" });
  }
  return found;
}

function manifestFor(directory) {
  const path = join(REPO_ROOT, directory === "/" ? "" : directory, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

test("the reader finds the holds", () => {
  const found = holds();
  assert.ok(found.length > 0, "no ignore entry was read: the reader no longer matches the file's layout");
  assert.equal(
    found.length,
    lines.filter((l) => /dependency-name:/.test(l)).length,
    "an ignore entry is written in a shape this reader skips",
  );
});

test("every hold says why it is there and what lifts it", () => {
  for (const hold of holds()) {
    const at = `.github/dependabot.yml:${hold.line} (${hold.name})`;
    assert.match(hold.comment, /\bWHY: .{30,}/, `${at} has no WHY above it`);
    assert.match(hold.comment, /\bLIFT WHEN: .{15,}/, `${at} does not say what lifts it`);
  }
});

test("every hold names a package its manifest still depends on", () => {
  for (const hold of holds()) {
    assert.ok(hold.directory, `${hold.name}: could not tell which manifest the block is for`);
    assert.ok(
      hold.name in manifestFor(hold.directory),
      `${hold.name} is held back in the ${hold.directory} block and that manifest no longer depends on it: remove the entry`,
    );
  }
});

test("a hold stops a major version and nothing smaller", () => {
  // Patch and minor releases are where fixes arrive. Holding those back is a
  // different decision, and it would need its own reason.
  for (const hold of holds()) {
    assert.match(
      hold.next,
      /^ {8}update-types: \["version-update:semver-major"\]$/,
      `${hold.name} is held back from more than major versions, or from every version`,
    );
  }
});
