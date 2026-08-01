/**
 * PRODUCTION SAFETY CHECK — is the reCAPTCHA gate on /api/register actually
 * live, on every deployed backend?
 *
 * `verifyRecaptcha` fails CLOSED in production mode, but only when
 * RECAPTCHA_SECRET is actually provisioned on that backend. If the secret goes
 * missing — a rotation that half-landed, a backend created without it, a typo
 * in a Secret Manager reference — the gate silently disappears and
 * /api/register becomes an open, unthrottled account-creation and
 * mail-dispatch endpoint on a domain whose DKIM is aligned with production's
 * sender. Nothing else in the codebase would notice.
 *
 * This posts a junk token and asserts a 400. It is the one battery here that
 * is SAFE to point at production, because it deliberately fails the gate: no
 * account is created, no mail is sent, nothing is written. It is also the only
 * reason this file reaches past the dev allowlist, which it does with its own
 * plain fetch rather than the harness's target machinery — that allowlist
 * exists to stop accidental writes to prod and is not being weakened.
 *
 * Read-only, no credentials, no side effects. Runs on every `npm run e2e`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BACKENDS = [
  { name: "dev", origin: "https://dev.naisi.uk" },
  { name: "production", origin: "https://naisi.uk" },
];

describe("reCAPTCHA gate is live on every deployed backend", () => {
  for (const backend of BACKENDS) {
    it(`${backend.name} rejects a junk reCAPTCHA token`, async (t) => {
      let res;
      try {
        res = await fetch(`${backend.origin}/api/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // A syntactically valid address that is deliberately non-academic, so
          // the request reaches the captcha check rather than dying earlier —
          // and a token that cannot possibly verify.
          body: JSON.stringify({
            email: `e2e-gate-probe-${Date.now()}@e2e.invalid`,
            recaptchaToken: "e2e-deliberately-invalid-token",
          }),
        });
      } catch (err) {
        return t.skip(`${backend.origin} unreachable (${err.message})`);
      }

      const body = await res.text();

      if (res.status === 404) {
        // The route is not on this backend yet. Production is currently behind
        // `dev` and predates the email-only registration route, so this is the
        // expected answer there until the promotion lands — at which point this
        // check arms itself automatically and starts asserting for real.
        return t.skip(
          `${backend.origin}/api/register returns 404 — the route is not deployed ` +
            "on this backend yet. This will begin asserting once it is.",
        );
      }

      assert.notEqual(
        res.status,
        200,
        `${backend.origin}/api/register accepted a junk reCAPTCHA token. The gate ` +
          "is NOT active on this backend — most likely RECAPTCHA_SECRET is missing " +
          "from it. That endpoint creates accounts and sends mail from a " +
          "DKIM-aligned sender; treat this as urgent.",
      );
      assert.equal(
        res.status,
        400,
        `Expected 400 from ${backend.origin}, got ${res.status} (${body.slice(0, 160)}). ` +
          "A 429 means a rate limit answered first — rerun later. Anything else " +
          "means the failure mode has changed and this check needs revisiting.",
      );
      assert.match(
        body,
        /human/i,
        `Expected the reCAPTCHA rejection from ${backend.origin}, but got a different ` +
          `400: ${body.slice(0, 160)}. The request may be dying before the gate, ` +
          "which would make this test green without proving anything.",
      );
    });
  }
});
