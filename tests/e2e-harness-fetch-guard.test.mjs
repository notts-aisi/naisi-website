/**
 * Every `fetch(` in the harness library goes through `fetchOrExplain`.
 *
 * WHY. The library's fetches set up and tear down (a custom token exchanged
 * with Identity Toolkit, a session cookie minted from the target, a Mailpit
 * read). A socket-level failure there is reported by undici as
 * `TypeError: fetch failed` with the real code on `cause`, which node:test
 * does not print, and a failure inside a `before` hook cancels every test in
 * the battery. On 8 September 2026 that took a deployed run down with nothing
 * in the log but "fetch failed". `scripts/e2e/lib/net.mjs` retries once when
 * no response came back and names the cause when it gives up.
 *
 * THE SPLIT IT KEEPS. The batteries under `scripts/e2e/tests/` fetch the
 * target directly and are NOT wrapped: their responses are the assertion, and
 * a repeated POST that the server had in fact processed would be a second
 * write. This guard reads the library only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB_DIR = join(REPO_ROOT, "scripts", "e2e", "lib");
const WRAPPER = join(LIB_DIR, "net.mjs");

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const files = readdirSync(LIB_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => join(LIB_DIR, f));

test("the wrapper exists and is the one place the library calls fetch", () => {
  assert.ok(files.includes(WRAPPER), `${relative(REPO_ROOT, WRAPPER)} is missing.`);
  assert.match(codeOf(WRAPPER), /\bawait fetch\(/, "net.mjs no longer calls fetch itself.");
});

test("every other fetch under scripts/e2e/lib goes through fetchOrExplain", () => {
  const offences = [];
  for (const file of files) {
    if (file === WRAPPER) continue;
    const source = codeOf(file);
    const bare = source.match(/(?<![\w.])fetch\s*\(/g) ?? [];
    if (bare.length > 0) {
      offences.push(`${relative(REPO_ROOT, file)} calls fetch( ${bare.length}x directly.`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    "Route it through fetchOrExplain from ./net.mjs, which retries a socket failure once " +
      "and names the cause. If the call must not be repeated, say so there rather than here.",
  );
});
