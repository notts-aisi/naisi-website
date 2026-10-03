/**
 * Input from a stranger is bounded before a pattern reads it, and the pattern
 * reads it once.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * Two patterns in the tree could be made slow by the text they were given,
 * and both were reachable with input the caller controls:
 *
 *  - `/api/register` matched the submitted address against a pattern in which
 *    a dot could fall on either side of `\.`, with no cap on the address. It
 *    is the one route here anybody can call with no session and no captcha
 *    answer yet, so the time it takes is the caller's to choose.
 *  - the course email preheader stripped tags with `<[^>]*>`, which starts
 *    again from every `<` in a run of them.
 *
 * Each is held three ways: the cap comes BEFORE the pattern, the pattern is
 * timed on the input that made the old one slow, and what the pattern accepts
 * is written down so that making it fast did not make it wrong.
 *
 * CodeQL holds the class (its results are required before a merge); this file
 * holds these two so that a revert fails here, by name, with the reason.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";
import { timeBoxed } from "./lib/timeBox.mjs";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = "src/app/api/register/route.ts";
const codeOf = (path) => stripSource(readFileSync(join(REPO_ROOT, path), "utf8"), { keepStrings: true });

// A pattern that has gone slow blocks the thread it runs on, so each probe
// runs in a worker that is stopped at the limit (tests/lib/timeBox.mjs).
const LIMIT_MS = 6000;
const BOUND_MS = 250;

// ---------------------------------------------------------------------------
// /api/register, run for real up to the point where it would touch anything
// ---------------------------------------------------------------------------

globalThis.__regOutcomes = [];
globalThis.__regTouched = [];

const STUBS = [
  ["server-only", "export {};"],
  [
    "next/server",
    "export const NextResponse = { json(body, init) { return { status: (init && init.status) || 200, json: async () => body }; } };",
  ],
  [
    "@/lib/firebase/admin",
    "export function getAdminAuth() { globalThis.__regTouched.push('auth'); return null; }\n" +
      "export function getAdminDb() { globalThis.__regTouched.push('db'); return null; }",
  ],
  ["@/lib/email/send", "export async function sendEmail() { globalThis.__regTouched.push('mail'); }"],
  ["@/lib/signedTokens", "export function randomOpaqueId() { return 'id'; }\nexport function signToken() { return 't'; }"],
  ["@/lib/firestore/users", "export function isAcademicEmail() { return false; }\nexport function isNottinghamEmail() { return false; }"],
  ["@/lib/authReturn", "export function safeFunnelReturn() { return null; }"],
  // The captcha says no, so an address that gets past the shape check stops
  // at the next gate, with a different answer from one that did not.
  ["@/lib/recaptcha/server", "export async function verifyRecaptcha() { return false; }"],
  ["@/lib/recaptcha/bypass", "export function recaptchaBypassGranted() { return false; }"],
  [
    "@/lib/rateLimit",
    "export function rateLimit() { return { ok: true, retryAfterSeconds: 0 }; }\nexport function clientIp() { return '203.0.113.1'; }",
  ],
  [
    "@/lib/firestore/registrationWrites",
    "export async function recordSignupOutcome(o) { globalThis.__regOutcomes.push(o); }\n" +
      "export async function recordRegistrationCreated() {}\nexport async function recordRegistrationResend() {}",
  ],
];

const { loadTs } = createLoader({ stubs: STUBS });
const route = await loadTs("app/api/register/route.ts");
const { EMAIL_MAX } = await loadTs("lib/firestore/events.ts");

async function register(body) {
  const res = await route.POST(
    new Request("https://naisi.test/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const INVALID = { status: 400, body: { error: "Enter a valid email address." } };

beforeEach(() => {
  globalThis.__regOutcomes.length = 0;
  globalThis.__regTouched.length = 0;
});

describe("/api/register bounds the address before it reads it", () => {
  test("an address over the cap is refused as malformed, quickly, whatever is in it", async () => {
    // The shape that made the old pattern quadratic, at a size that used to
    // pin a worker for minutes.
    const hostile = `!@${"!.".repeat(400_000)}`;
    let answer;
    const started = performance.now();
    answer = await register({ email: hostile });
    const took = performance.now() - started;
    assert.deepEqual(answer, INVALID);
    assert.ok(took < 1000, `took ${Math.round(took)} ms`);
    assert.deepEqual(globalThis.__regOutcomes, ["invalid-email"]);
  });

  test("the cap is the one the RSVP route applies to the same field", async () => {
    const at = (length) => `${"a".repeat(length - "@example.org".length)}@example.org`;
    assert.equal(at(EMAIL_MAX).length, EMAIL_MAX);
    // Exactly at the cap is read (and stopped by the captcha, the next gate).
    assert.equal((await register({ email: at(EMAIL_MAX) })).body.error, "Couldn't verify you're human. Please try again.");
    // One over is not.
    assert.deepEqual(await register({ email: at(EMAIL_MAX + 1) }), INVALID);
  });

  test("an email that is not a string is refused, not thrown on", async () => {
    for (const email of [42, true, null, ["a@b.co"], { toString: "x" }, undefined]) {
      assert.deepEqual(await register({ email }), INVALID, JSON.stringify(email));
    }
    assert.deepEqual(await register({}), INVALID);
  });

  test("nothing is created, read or sent for an address that is refused", async () => {
    await register({ email: `!@${"!.".repeat(50_000)}` });
    await register({ email: "not an address" });
    await register({ email: 7 });
    assert.deepEqual(globalThis.__regTouched, []);
  });

  test("an ordinary address still gets past the shape check", async () => {
    for (const email of ["someone@example.org", "  Someone@Example.ORG  ", "first.last+tag@sub.example.co.uk", "o'brien@example.ie"]) {
      const answer = await register({ email });
      assert.equal(answer.body.error, "Couldn't verify you're human. Please try again.", email);
    }
    assert.ok(globalThis.__regOutcomes.every((o) => o === "recaptcha-failed"));
  });

  test("the cap is applied before the pattern, in the source", () => {
    const code = codeOf(REGISTER);
    const handler = code.slice(code.indexOf("export async function POST"));
    const cap = handler.search(/\.length\s*>\s*EMAIL_MAX/);
    const match = handler.search(/EMAIL_SHAPE\.test\(/);
    assert.ok(cap > 0, "the handler no longer caps the address");
    assert.ok(match > 0, "the handler no longer tests the address against EMAIL_SHAPE");
    assert.ok(cap < match, "the pattern runs before the cap");
    assert.match(
      handler,
      /const sent: unknown = body\.email;\s*const submitted = typeof sent === "string" \? sent : "";/,
      "the address is no longer read as a string or not at all",
    );
    // No second pattern has crept in beside the bounded one.
    assert.equal([...handler.matchAll(/\/\^?\[\^@/g)].length, 0, "an inline address pattern is back in the handler");
  });
});

describe("the address pattern reads its input once", () => {
  const source = readFileSync(join(REPO_ROOT, REGISTER), "utf8");
  const literal = source.match(/const EMAIL_SHAPE = \/(.+)\/;/);
  assert.ok(literal, "EMAIL_SHAPE could not be read out of the route");
  const EMAIL_SHAPE = new RegExp(literal[1]);

  test("it accepts what an address looks like and refuses what it does not", () => {
    for (const ok of ["a@b.co", "first.last@example.org", "x+y@sub.domain.example", "o'brien@example.ie", "a@b.c.d.e"]) {
      assert.ok(EMAIL_SHAPE.test(ok), ok);
    }
    for (const bad of ["", "a", "a@b", "@b.co", "a@", "a@@b.co", "a b@c.co", "a@b .co", "a@b..co", "a@.b.co", "a@b.co.", "a@b@c.co"]) {
      assert.ok(!EMAIL_SHAPE.test(bad), bad);
    }
  });

  test("no host label can hold a dot, which is what makes it linear", () => {
    // Each character of the host can be matched in exactly one way.
    assert.ok(literal[1].includes("[^@\\s.]"), "a host label can match a dot again");
    assert.ok(!/\[\^@\\s\]\+\\\.\[\^@\\s\]\+/.test(literal[1]), "the quadratic shape is back");
  });

  test("the input that made the old pattern slow is read at once, cap or no cap", async () => {
    for (const repeat of [["!@", "!.", 200_000, ""], ["a@", ".", 200_000, ""], ["a@", "b.", 200_000, "!@"], ["", "a", 200_000, ""]]) {
      const run = await timeBoxed({ kind: "regex-test", source: literal[1], repeat }, LIMIT_MS);
      const what = `${repeat[0]}${repeat[1]}${repeat[1]}...${repeat[3]}`;
      assert.ok(run.finished, `${what}: still running after ${LIMIT_MS} ms and was stopped`);
      assert.ok(run.took < BOUND_MS, `${what}: took ${Math.round(run.took)} ms`);
    }
  });
});

// ---------------------------------------------------------------------------
// The course email preheader
// ---------------------------------------------------------------------------

describe("the course email preheader strips tags in one pass", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/email/courseNudgeEmail.ts"), "utf8");
  const body = source.slice(source.indexOf("function preheaderOf("));
  const literal = body.slice(0, body.indexOf("\n}\n")).match(/block\.html\.replace\(\/(.+?)\/g, " "\)/);

  test("the pattern can be read out of preheaderOf", () => {
    assert.ok(literal, "preheaderOf no longer strips tags with a pattern this test can find");
  });

  test("a tag cannot hold another opening bracket", () => {
    assert.equal(literal[1], "<[^<>]*>");
  });

  test("it still turns markup into text", () => {
    const strip = (html) => html.replace(new RegExp(literal[1], "g"), " ");
    assert.equal(strip("<p>Hi <strong>Alex</strong>,</p>").replace(/\s+/g, " ").trim(), "Hi Alex ,");
    assert.equal(strip('<a href="https://naisi.uk">this week</a>').trim(), "this week");
  });

  test("a run of opening brackets is read at once", async () => {
    for (const repeat of [["", "<", 200_000, ""], ["", "<a", 200_000, ""], ["", "<", 200_000, ">"]]) {
      const run = await timeBoxed({ kind: "regex-replace", source: literal[1], repeat }, LIMIT_MS);
      const what = `${repeat[1]}${repeat[1]}${repeat[1]}...${repeat[3]}`;
      assert.ok(run.finished, `${what}: still running after ${LIMIT_MS} ms and was stopped`);
      assert.ok(run.took < BOUND_MS, `${what}: took ${Math.round(run.took)} ms`);
    }
  });
});
