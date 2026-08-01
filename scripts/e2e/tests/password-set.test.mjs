/**
 * The verify-first register flow creates an account with a SERVER-RANDOM
 * throwaway password, and `/api/register/password-set` is where the user
 * replaces it after proving inbox ownership. If that replacement silently
 * failed, the account would keep a password nobody knows — the user would
 * appear registered, and every later sign-in attempt would fail with no
 * indication why.
 *
 * By hand this is close to unverifiable: the UI shows the same success screen
 * whether or not the credential actually changed. The only proof is asking
 * Identity Toolkit to sign in with each password.
 *
 * No email, no Firestore: the "throwaway" is set directly via the Admin SDK,
 * which is exactly what /api/register does with its randomBytes(24) value.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadEnv, runId } from "../lib/env.mjs";
import { harnessEmail } from "../lib/admin.mjs";
import { trySignInWithPassword } from "../lib/identity.mjs";
import { authedFetch, withHarnessSession } from "../lib/session.mjs";

describe("password-set replaces the throwaway credential", () => {
  let session;
  let email;
  const throwaway = randomBytes(24).toString("base64");
  const chosen = `e2e-chosen-${randomBytes(6).toString("hex")}`;

  before(async () => {
    loadEnv();
    const id = runId();
    email = harnessEmail(id);
    // The throwaway is set AT CREATION, standing in for /api/register's
    // randomBytes(24) value. (That route is reCAPTCHA-gated and cannot be
    // driven against dev — see register-enumeration.test.mjs.)
    //
    // Setting it after the session is minted would revoke that session:
    // updateUser({password}) bumps validSince, and getSessionUid() verifies
    // with checkRevoked: true. Discovering that is what the session-revocation
    // test below now pins down.
    session = await withHarnessSession(id, { password: throwaway });
  });

  after(async () => {
    if (session) await session.dispose().catch(() => {});
  });

  it("POSITIVE CONTROL: the throwaway password works before the swap", async () => {
    const result = await trySignInWithPassword(email, throwaway);
    assert.equal(
      result.ok,
      true,
      `The seeded throwaway password was refused (${result.reason}). Without this ` +
        "control, the 'old password no longer works' assertion below would pass " +
        "even if the password had never worked in the first place.",
    );
  });

  // Declaration order is execution order, and it matters: a successful
  // password-set revokes the session cookie, so every test that needs a live
  // session must run BEFORE the swap.
  it("rejects a too-short password with 400", async () => {
    const res = await authedFetch(session.cookie, "/api/register/password-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "abc" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const res = await fetch(`${loadEnv().origin}/api/register/password-set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "some-other-password" }),
    });
    assert.equal(
      res.status,
      401,
      "password-set must never act without a session — it changes a credential.",
    );
  });

  it("accepts the new password and reports ok", async () => {
    const res = await authedFetch(session.cookie, "/api/register/password-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: chosen }),
    });
    assert.equal(res.status, 200, `password-set returned ${res.status}`);
    const body = await res.json().catch(() => null);
    assert.equal(body?.ok, true);
  });

  it("the throwaway password no longer works", async () => {
    const result = await trySignInWithPassword(email, throwaway);
    assert.equal(
      result.ok,
      false,
      "The server-random throwaway password STILL signs in after password-set. " +
        "A credential the user never chose — and which is generated where it can " +
        "be logged — remains valid on the account.",
    );
  });

  it("the chosen password works", async () => {
    const result = await trySignInWithPassword(email, chosen);
    assert.equal(
      result.ok,
      true,
      `The password the user chose does not work (${result.reason}). password-set ` +
        "reported success but the credential did not change — the user is locked " +
        "out of an account that looks registered.",
    );
  });

  /**
   * CHARACTERISATION — the harness found this, and it is the reason the
   * assertions above had to be reordered.
   *
   * `password-set` calls Admin `updateUser({password})`, which bumps the
   * user's `validSince`. Every session check in src/lib/firebase/session.ts
   * except one verifies with `checkRevoked: true`, so the caller's OWN
   * `__session` cookie is dead the instant their password is saved.
   *
   * That matters beyond this test: in the real email/password register flow,
   * `completeRegistration` later POSTs `/api/verify-email/reconcile` on that
   * same cookie — and reconcile is what stamps `profile.uniEmailVerifiedAt`
   * for anyone who clicked their uni-email link before the profile existed
   * (the PR #216 fix). See uni-email-stamp.test.mjs for the paired test that
   * drives that exact sequence.
   *
   * This test pins CURRENT behaviour. If it starts failing because the cookie
   * survives, that is a deliberate change worth noticing, not a break.
   */
  it("CHARACTERISATION: setting a password revokes the caller's own session", async () => {
    const res = await authedFetch(session.cookie, "/api/verify-email/reconcile", {
      method: "POST",
    });
    assert.equal(
      res.status,
      401,
      "Expected the pre-password-set cookie to be revoked. If this now returns " +
        "200, session revocation on password change has changed behaviour.",
    );
  });
});
