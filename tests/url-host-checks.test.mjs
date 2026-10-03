/**
 * Whether an address belongs to a host is decided by parsing the address.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * `href.includes("accounts.google.com")` is true of
 * `https://elsewhere.example/?next=accounts.google.com` and of
 * `https://accounts.google.com.elsewhere.example/`. The one place the tree did
 * this only chose whether to show a sign-in message, so nothing was trusted on
 * the strength of it, but the same line copied into a redirect check would be
 * an open door. So the rule is held for the tree: a host name inside
 * `includes`, `indexOf`, `startsWith`, `endsWith`, `match` or `search` is
 * either parsed instead, or listed here with what the string really is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const posix = (file) => relative(REPO_ROOT, file).split("\\").join("/");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** A string method handed something that ends like a host name. */
const HOST_BY_TEXT =
  /\.(includes|indexOf|startsWith|endsWith|match|search)\(\s*["'`/][^"'`)]*[a-z0-9-]+\.(com|uk|org|net|io|app|dev|page)\b/;

/** Files where the string is not a web address at all, and what it is. */
const NOT_AN_ADDRESS = {
  "src/lib/firebase/admin.ts":
    "the suffix of a service account's EMAIL address, compared against the project it was built from",
};

test("the detector sees the shape it is for", () => {
  assert.match('if (href.includes("accounts.google.com")) {', HOST_BY_TEXT);
  assert.match("url.startsWith('https://naisi.uk')", HOST_BY_TEXT);
  assert.doesNotMatch('new URL(href).hostname === "accounts.google.com"', HOST_BY_TEXT);
  assert.doesNotMatch('list.includes("committee")', HOST_BY_TEXT);
});

test("no file under src decides a host by looking for its name in a string", () => {
  const offenders = [];
  let read = 0;
  for (const file of walk(SRC)) {
    read += 1;
    const path = posix(file);
    if (path in NOT_AN_ADDRESS) continue;
    const code = stripSource(readFileSync(file, "utf8"), { keepStrings: true });
    for (const line of code.split("\n")) {
      if (HOST_BY_TEXT.test(line)) offenders.push(`${path}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.ok(read > 100, "the walk read almost nothing under src");
  assert.deepEqual(
    offenders,
    [],
    "Parse the address and compare its host: `new URL(href, base).hostname === \"example.org\"`. " +
      "A host name found by text is also found in a query string and in a longer host name. If the " +
      "string is not a web address, list the file in NOT_AN_ADDRESS and say what it is.",
  );
});

test("every listed exception still has the line that needs it", () => {
  for (const path of Object.keys(NOT_AN_ADDRESS)) {
    const code = stripSource(readFileSync(join(REPO_ROOT, path), "utf8"), { keepStrings: true });
    assert.ok(
      code.split("\n").some((line) => HOST_BY_TEXT.test(line)),
      `${path} no longer does this: remove it from NOT_AN_ADDRESS`,
    );
  }
});

test("the Google sign-in button compares the host of the parsed address", () => {
  const code = stripSource(readFileSync(join(SRC, "components/GoogleSignInButton.tsx"), "utf8"), { keepStrings: true });
  assert.match(code, /new URL\(href, window\.location\.href\)\.hostname === "accounts\.google\.com"/);
  // An address it cannot parse is not Google's, and must not throw inside a
  // wrapper around window.open.
  assert.match(code, /function opensGoogleSignIn[\s\S]*?try \{[\s\S]*?\} catch \{\s*return false;/);
});
