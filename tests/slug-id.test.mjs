/**
 * Document ids: `{slug}__{8 base36 characters}`, and the eight are not
 * guessable.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * `slugId` names most documents the app creates. Its suffix came from
 * `Math.random`, whose next value can be worked out from a handful of earlier
 * ones. Nothing treats an id as a secret, but ids minted on the server are
 * shown to clients, and an id that cannot be predicted costs one call to the
 * platform's cryptographic generator. This holds the SHAPE (other code and the
 * Firestore console both depend on it) and the SOURCE of the randomness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadTs } = createLoader();
const { slugId, slugify } = await loadTs("lib/firestore/slugId.ts");

test("the shape is the slug, two underscores and eight base36 characters", () => {
  assert.match(slugId("Review the new design doc"), /^review-the-new-design-doc__[0-9a-z]{8}$/);
  assert.match(slugId(""), /^untitled__[0-9a-z]{8}$/);
  assert.match(slugId("Café & Crème"), /^cafe-creme__[0-9a-z]{8}$/);
  // An id never starts with the separator, which Firestore reserves.
  assert.ok(!slugId("__").startsWith("__"));
  assert.equal(slugify("  Hello,  World!  "), "hello-world");
});

test("twenty thousand ids for one title are all different", () => {
  const seen = new Set();
  for (let i = 0; i < 20_000; i += 1) seen.add(slugId("same title"));
  assert.equal(seen.size, 20_000);
});

test("every base36 character turns up, in every position, about as often as the others", () => {
  // 36 characters over 8 positions and 20,000 ids: each character is expected
  // about 4,444 times. A generator that folded bytes in with a plain modulo,
  // or dropped a character, shows up as a count far outside this band.
  const counts = new Map();
  const perPosition = Array.from({ length: 8 }, () => new Set());
  for (let i = 0; i < 20_000; i += 1) {
    const suffix = slugId("x").split("__")[1];
    [...suffix].forEach((ch, at) => {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
      perPosition[at].add(ch);
    });
  }
  assert.equal(counts.size, 36, `only ${counts.size} of 36 characters ever appeared`);
  for (const [ch, n] of counts) assert.ok(n > 3800 && n < 5100, `"${ch}" appeared ${n} times`);
  for (const [at, chars] of perPosition.entries()) assert.equal(chars.size, 36, `position ${at} never showed some character`);
});

test("the suffix comes from the cryptographic generator", () => {
  const code = stripSource(readFileSync(join(REPO_ROOT, "src/lib/firestore/slugId.ts"), "utf8"), { keepStrings: true });
  assert.match(code, /crypto\.getRandomValues\(/);
  assert.doesNotMatch(code, /Math\.random/, "slugId is drawing from Math.random again");
});

test("it draws from that generator and from nothing else", (t) => {
  // Hand it a generator that only ever says zero: every character must then
  // be the first of the alphabet, which it could not be if any other source
  // of randomness were mixed in.
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes) => bytes.fill(0));
  assert.equal(slugId("x"), "x__00000000");
});

test("a byte that would bias the result is thrown away, not folded in", (t) => {
  // 252 to 255 are the bytes past the last whole run of 36. A generator that
  // returns only those must be asked again rather than have them wrapped
  // round to the first four characters.
  let calls = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes) => {
    calls += 1;
    return bytes.fill(calls < 3 ? 255 : 35);
  });
  assert.equal(slugId("x"), "x__zzzzzzzz");
  assert.equal(calls, 3);
});
