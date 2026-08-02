/**
 * THE PR #209 REGRESSION GUARD — the highest-value assertion in this suite.
 *
 * PR #209 reverted a change that let any account get `uniEmailVerifiedAt`
 * stamped for an address it did not own, i.e. "anyone becomes a verified
 * member". The server-side gate that prevents it is the
 * `validateUniversityEmail()` call in src/app/api/verify-email/send/route.ts:
 * the magic link proving University of Nottingham affiliation may only ever be
 * sent TO a Nottingham address. Had this test existed, that bypass could not
 * have shipped.
 *
 * ORDERING TRAP this test is written around: the route checks
 * `getCurrentUser()` (401) BEFORE it validates the address (400). An
 * unauthenticated probe therefore gets 401 — green for the wrong reason,
 * proving nothing about the gate. So case 1 pins the 401 explicitly and every
 * later case runs with a real session and asserts 400, which is only
 * reachable past the auth check.
 *
 * NO EMAIL IS SENT by any case here: every address is rejected before the
 * route reaches its send block. There is deliberately no positive control
 * with a real @nottingham.ac.uk address — that would dispatch real mail from
 * the domain production's deliverability depends on.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, runId } from "../lib/env.mjs";
import { anonFetch, authedFetch, withHarnessSession } from "../lib/session.mjs";

const SEND = "/api/verify-email/send";

describe("uni-email gate (PR #209 regression guard)", () => {
  let session;

  before(async () => {
    loadEnv();
    session = await withHarnessSession(runId());
  });

  after(async () => {
    if (session) await session.dispose();
  });

  it("rejects an unauthenticated caller with 401 (the ordering trap)", async () => {
    const res = await anonFetch(SEND, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@gmail.com" }),
    });
    assert.equal(
      res.status,
      401,
      "Expected 401 for an unauthenticated caller. If this ever returns 400, the " +
        "auth check has moved behind the email check and the rest of this file " +
        "would start passing without a session — i.e. testing nothing.",
    );
  });

  it("rejects a non-Nottingham address with 400 (THE guard)", async () => {
    const res = await authedFetch(session.cookie, SEND, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@gmail.com" }),
    });
    const body = await res.json().catch(() => null);
    assert.equal(
      res.status,
      400,
      `Expected 400 for @gmail.com with a valid session, got ${res.status}. ` +
        "A 2xx here is the PR #209 bypass reopening: the uni-email magic link " +
        "could be sent to an address the caller does not own, and confirming it " +
        "stamps uniEmailVerifiedAt on their account.",
    );
    assert.match(
      body?.error ?? "",
      /Nottingham email/i,
      "Expected the Nottingham-address rejection, not some other 400.",
    );
  });

  for (const [label, email] of [
    ["a lookalike suffix domain", "someone@nottingham.ac.uk.attacker.example"],
    ["a hyphen-prefixed domain", "someone@evil-nottingham.ac.uk"],
    ["a substring-only domain", "someone@notnottingham.ac.uk.co"],
    ["an empty address", ""],
  ]) {
    it(`rejects ${label} with 400`, async () => {
      const res = await authedFetch(session.cookie, SEND, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      assert.equal(
        res.status,
        400,
        `Expected 400 for ${JSON.stringify(email)}, got ${res.status}. ` +
          "UNI_EMAIL_PATTERN anchors on the full host; a change that made this " +
          "pass would accept attacker-controlled domains as proof of UoN affiliation.",
      );
    });
  }
});
