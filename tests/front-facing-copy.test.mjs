/**
 * Two decisions about what the public site says, held in place.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * 1. THE SITE DOES NOT PROMISE HOW OFTEN IT EMAILS. Both sign-up forms and the
 *    profile's notification grid described the newsletter and the event
 *    announcements as low frequency. Event announcements go out whenever an
 *    event is published, which in freshers' week is often, so the promise was
 *    one the society did not keep and had no way to. The phrase had been
 *    pasted into five places, which is how it would come back. Copy says what
 *    an email IS; it does not say how many there will be.
 *
 * 2. /resources IS HIDDEN FOR NOW. The page is being rewritten and the owner
 *    would rather nothing showed than what is there. A temporary redirect in
 *    next.config.ts takes over from the page without touching it, and nothing
 *    on the site links to it. TO BRING IT BACK: delete the /resources entry in
 *    next.config.ts, restore the three links commented out in PublicHeader,
 *    PublicFooter and src/content/links.ts, and delete the second half of
 *    this file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (file) => relative(REPO_ROOT, file).split("\\").join("/");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** Code with its comments gone and its strings kept: copy lives in strings. */
const copyOf = (file) => stripSource(readFileSync(file, "utf8"), { keepStrings: true });

describe("the site does not promise how often it emails", () => {
  // The published legal texts are frozen archives with their own guard, and
  // they make no such promise anyway.
  const FROZEN = "src/content/legal/";
  const PROMISE = /low[- ]?frequency|low[- ]?volume|infrequent(ly)? (email|update|message)|only (email|message) (you )?occasionally/i;

  test("no string or JSX text under src makes the promise", () => {
    const offenders = [];
    for (const file of walk(join(REPO_ROOT, "src"))) {
      const path = posix(file);
      if (path.startsWith(FROZEN)) continue;
      const hit = copyOf(file).match(PROMISE);
      if (hit) offenders.push(`${path}: "${hit[0]}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "Say what the email is, not how many there will be. Event announcements go out " +
        "whenever an event is published, so a promise of low volume is one nobody can keep.",
    );
  });

  test("the detector sees the phrase in copy and ignores it in a comment", () => {
    assert.match(stripSource('const d = "A round-up. Low frequency.";', { keepStrings: true }), PROMISE);
    assert.doesNotMatch(stripSource("// Low-volume use case; the race is benign\nconst x = 1;", { keepStrings: true }), PROMISE);
  });
});

describe("/resources is hidden for now", () => {
  test("a temporary redirect takes over from the page", () => {
    const config = stripSource(readFileSync(join(REPO_ROOT, "next.config.ts"), "utf8"), { keepStrings: true });
    assert.match(
      config,
      /source: "\/resources",\s*destination: "\/",\s*permanent: false/,
      "the redirect is missing, or is permanent. A 308 is cached by browsers for good, and this is meant to be undone.",
    );
  });

  test("the page it hides is still there to bring back", () => {
    assert.doesNotThrow(() => statSync(join(REPO_ROOT, "src/app/(public)/resources/page.tsx")));
  });

  test("nothing on the site links to it", () => {
    // A link to a page that redirects home bounces somebody back to where
    // they started. Comments are stripped, so the three links commented out
    // for the restore do not count.
    const offenders = [];
    for (const file of walk(join(REPO_ROOT, "src"))) {
      const path = posix(file);
      if (path.startsWith("src/app/(public)/resources/")) continue;
      if (/["'`]\/resources["'`#?]/.test(copyOf(file))) offenders.push(path);
    }
    assert.deepEqual(offenders, []);
  });
});
