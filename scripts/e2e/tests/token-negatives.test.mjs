/**
 * The magic-link token negatives — the cases nobody hand-tests, because
 * producing them by hand means forging an HMAC.
 *
 * All of these run unauthenticated against /api/verify-email/confirm, which is
 * a thin façade over confirmUniEmailVerification(). No email is sent and no
 * Firestore document is written on any path exercised here.
 *
 * THE POSITIVE CONTROL MATTERS MOST: "valid signature, unknown doc id" must
 * return 404, not 400. 404 means the server accepted our signature and got as
 * far as the Firestore lookup — which proves this harness reproduces the HMAC
 * byte-for-byte AND that .env.e2e.local holds the same EVENTS_TOKEN_SECRET the
 * target is running. Without it, every negative below could be passing merely
 * because our tokens are malformed, and the suite would be worthless while
 * looking green.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../lib/env.mjs";
import { anonFetch } from "../lib/session.mjs";
import { opaqueId, signToken, tamperBody, tamperSignature } from "../lib/tokens.mjs";

const CONFIRM = "/api/verify-email/confirm";
const TTL = 1800; // matches TOKEN_TTL_SECONDS in the send route

function post(signed) {
  return anonFetch(CONFIRM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed }),
  });
}

describe("magic-link token negatives", () => {
  let env;
  let skipReason = null;

  before(() => {
    env = loadEnv();
    if (!env.tokenSecret) {
      skipReason =
        "EVENTS_TOKEN_SECRET absent from .env.e2e.local — token minting unavailable. " +
        "Fetch the DEV project's secret from Secret Manager to enable this battery.";
    }
  });

  it("POSITIVE CONTROL: a validly-signed token for an unknown doc id reaches Firestore (404)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const signed = signToken({ s: "verify-uni-email", v: opaqueId() }, TTL, env.tokenSecret);
    const res = await post(signed);
    assert.equal(
      res.status,
      404,
      `Expected 404 (signature accepted, doc absent) but got ${res.status}. ` +
        "A 400 here means the target REJECTED our signature: either the payload " +
        "shape drifted from src/lib/signedTokens.ts ({s,v,iat,exp}, HMAC over the " +
        "base64url body string, key order significant), or .env.e2e.local's " +
        "EVENTS_TOKEN_SECRET is not the value the target is running. Every other " +
        "assertion in this file is meaningless until this one passes.",
    );
  });

  it("rejects a missing token with 400", async () => {
    const res = await post(undefined);
    assert.equal(res.status, 400);
    const body = await res.json().catch(() => null);
    assert.match(body?.error ?? "", /Missing token/i);
  });

  it("rejects a tampered signature with 400", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const signed = signToken({ s: "verify-uni-email", v: opaqueId() }, TTL, env.tokenSecret);
    const res = await post(tamperSignature(signed));
    assert.equal(res.status, 400, "A flipped signature byte must not verify.");
  });

  it("rejects a token whose body was edited after signing with 400", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const signed = signToken({ s: "verify-uni-email", v: opaqueId() }, TTL, env.tokenSecret);
    // Swap in a different verification doc id, keeping the original signature:
    // the attack of "I have my own valid link, point it at someone else's row".
    const res = await post(tamperBody(signed, (p) => ({ ...p, v: opaqueId() })));
    assert.equal(
      res.status,
      400,
      "Re-pointing a signed token at another emailVerifications doc must fail.",
    );
  });

  it("rejects an expired token with 400", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const signed = signToken({ s: "verify-uni-email", v: opaqueId() }, -60, env.tokenSecret);
    const res = await post(signed);
    assert.equal(res.status, 400, "exp in the past must be rejected.");
  });

  it("rejects an extended-expiry replay with 400", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const signed = signToken({ s: "verify-uni-email", v: opaqueId() }, -60, env.tokenSecret);
    // Push exp into the future without re-signing — the signature no longer
    // covers the body, so this must fail on the HMAC, not on expiry.
    const res = await post(
      tamperBody(signed, (p) => ({ ...p, exp: Math.floor(Date.now() / 1000) + 3600 })),
    );
    assert.equal(res.status, 400, "An unsigned expiry extension must not verify.");
  });

  for (const scope of ["unsubscribe", "public-confirm", "verify-login-email"]) {
    it(`rejects a cross-scope replay from "${scope}" with 400`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      // Same secret, different scope: the whole point of the `s` field is that
      // a token minted for one flow cannot be presented to another. An
      // unsubscribe link arriving in any inbox must never confer uni-email
      // verification.
      const signed = signToken({ s: scope, v: opaqueId() }, TTL, env.tokenSecret);
      const res = await post(signed);
      assert.equal(
        res.status,
        400,
        `A "${scope}" token was accepted by the verify-uni-email confirm route. ` +
          "Scope separation is what makes sharing one signing secret across flows safe.",
      );
    });
  }
});
