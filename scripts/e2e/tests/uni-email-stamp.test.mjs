/**
 * THE TWO-PHASE `uniEmailVerifiedAt` STAMP — the assertion the design brief
 * calls out as impossible to check by hand.
 *
 * `confirmUniEmailVerification` deliberately SKIPS stamping
 * `users/{uid}.profile.uniEmailVerifiedAt` when the user document does not yet
 * exist — which is the normal case in the verify-first flow, where someone
 * clicks their uni-email link before finishing the profile form.
 * `/api/verify-email/reconcile` (PR #216) closes that gap afterwards.
 *
 * Clicking through by hand, the UI reads "verified" either way. Only an
 * Admin-SDK read of the user document distinguishes "reconcile fired" from
 * "the stamp was silently lost" — and a lost stamp means the member's uni
 * email is not actually attested, which is the trust signal the whole
 * uni-email flow exists to produce.
 *
 * NO EMAIL IS SENT: the `emailVerifications` record is seeded directly rather
 * than by calling /api/verify-email/send, which would dispatch real mail to a
 * @nottingham.ac.uk address that does not exist. The magic-link confirm leg is
 * then driven for real against the live route.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, runId } from "../lib/env.mjs";
import { harnessEmail } from "../lib/admin.mjs";
import {
  createLedger,
  readEmailVerification,
  readUserDoc,
  seedEmailVerification,
  seedPendingUserDoc,
} from "../lib/firestore.mjs";
import { authedFetch, withHarnessSession } from "../lib/session.mjs";
import { opaqueId, signToken } from "../lib/tokens.mjs";

describe("two-phase uniEmailVerifiedAt stamp", () => {
  let env;
  let session;
  let ledger;
  let tokenId;
  let uniEmail;
  let skipReason = null;

  before(async () => {
    env = loadEnv();
    if (!env.tokenSecret) {
      skipReason =
        "EVENTS_TOKEN_SECRET absent from .env.e2e.local — the magic-link leg cannot be minted.";
      return;
    }
    const id = runId();
    session = await withHarnessSession(id);
    ledger = createLedger();
    tokenId = opaqueId();
    // Unique per run: findVerifiedUniEmailOwner scans every user document, and
    // a leftover fixture holding this address would make confirm return 409.
    uniEmail = `e2e-${id}@nottingham.ac.uk`;
    await seedEmailVerification(ledger, {
      tokenId,
      email: uniEmail,
      authUid: session.uid,
    });
  });

  after(async () => {
    if (ledger) await ledger.teardown();
    if (session) await session.dispose().catch(() => {});
  });

  it("PHASE 1: confirming the link marks the verification record", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const signed = signToken({ s: "verify-uni-email", v: tokenId }, 1800, env.tokenSecret);
    const res = await authedFetch(session.cookie, "/api/verify-email/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed }),
    });
    assert.equal(res.status, 200, `confirm returned ${res.status}`);
    const body = await res.json().catch(() => null);
    assert.equal(body?.email, uniEmail);

    const record = await readEmailVerification(tokenId);
    assert.ok(
      record?.verifiedAt,
      "emailVerifications.verifiedAt was not set — the server-side proof of " +
        "verification that reconcile later reads does not exist.",
    );
  });

  it("PHASE 1: the stamp is NOT on the user doc yet (the documented gap)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const user = await readUserDoc(session.uid);
    assert.equal(
      user,
      null,
      "A user document exists that this test never created. The gap this test " +
        "characterises depends on confirm running before the profile is made.",
    );
  });

  it("PHASE 2: reconcile stamps the user doc once it exists", async (t) => {
    if (skipReason) return t.skip(skipReason);
    // Stand in for completeRegistration creating the profile — role "pending",
    // which grants access to nothing.
    await seedPendingUserDoc(ledger, {
      uid: session.uid,
      email: harnessEmail(session.email.replace(/^e2e-|@.*$/g, "")),
      universityEmail: uniEmail,
    });

    const before = await readUserDoc(session.uid);
    assert.equal(
      before?.profile?.uniEmailVerifiedAt ?? null,
      null,
      "The freshly-created user doc already carries a stamp — the fixture is wrong.",
    );

    const res = await authedFetch(session.cookie, "/api/verify-email/reconcile", {
      method: "POST",
    });
    assert.equal(res.status, 200, `reconcile returned ${res.status}`);
    const body = await res.json().catch(() => null);
    assert.equal(
      body?.stamped,
      true,
      "reconcile reported no stamp despite a verified emailVerifications record.",
    );

    const after = await readUserDoc(session.uid);
    assert.ok(
      after?.profile?.uniEmailVerifiedAt,
      "THE ASSERTION: users/{uid}.profile.uniEmailVerifiedAt is still empty after " +
        "reconcile. The member's university email is not actually attested, while " +
        "every UI surface reads 'verified' — invisible by hand, which is why the " +
        "two-phase gap needed PR #216 in the first place.",
    );
    assert.equal(
      after?.profile?.universityEmail,
      uniEmail,
      "The stamp must stay bound to the address it attests to.",
    );
  });

  it("PHASE 2: reconcile is idempotent", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const res = await authedFetch(session.cookie, "/api/verify-email/reconcile", {
      method: "POST",
    });
    assert.equal(res.status, 200, "A repeat reconcile must not error.");
  });

  it("reconcile refuses an unauthenticated caller", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const res = await fetch(`${env.origin}/api/verify-email/reconcile`, { method: "POST" });
    assert.equal(res.status, 401);
  });
});

/**
 * THE REAL SEQUENCE, in the order an email/password registrant performs it.
 * The battery above proves reconcile works on a healthy session; this proves
 * whether it survives what actually happens first — setting a password.
 *
 *   magic link → session → SET PASSWORD → fill profile → reconcile
 *
 * `password-set` revokes the caller's session cookie (see
 * password-set.test.mjs), and `completeRegistration` does NOT re-establish it
 * before POSTing reconcile — it just warns and moves on when the response is
 * not ok (src/auth/signInWithGoogle.ts). If reconcile 401s here, the stamp
 * silently never lands and PR #216's fix is defeated for this entire flow,
 * while every UI surface still reads "verified".
 */
describe("the stamp survives the real register sequence", () => {
  let env;
  let session;
  let ledger;
  let tokenId;
  let uniEmail;
  let skipReason = null;

  before(async () => {
    env = loadEnv();
    if (!env.tokenSecret) {
      skipReason = "EVENTS_TOKEN_SECRET absent — magic-link leg cannot be minted.";
      return;
    }
    const id = runId();
    session = await withHarnessSession(id);
    ledger = createLedger();
    tokenId = opaqueId();
    uniEmail = `e2e-${id}seq@nottingham.ac.uk`;
    await seedEmailVerification(ledger, { tokenId, email: uniEmail, authUid: session.uid });
  });

  after(async () => {
    if (ledger) await ledger.teardown();
    if (session) await session.dispose().catch(() => {});
  });

  // KNOWN FAILING, deliberately recorded rather than deleted. Confirmed
  // against dev.naisi.uk on 2026-08-01: reconcile returns 401 and the stamp
  // never lands. Marked `todo` so it does not block the suite as a regression
  // gate; when the app is fixed this starts passing and node reports it.
  it("stamps uniEmailVerifiedAt even after the password has been set", {
    todo: "FAILS TODAY: password-set revokes the session cookie reconcile needs (401), so the uni-email stamp is silently lost for email/password registrants.",
  }, async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 1. Click the uni-email magic link (before the profile exists).
    const signed = signToken({ s: "verify-uni-email", v: tokenId }, 1800, env.tokenSecret);
    const confirm = await authedFetch(session.cookie, "/api/verify-email/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed }),
    });
    assert.equal(confirm.status, 200, "confirm leg failed");

    // 2. Set a password — what every email/password registrant does next.
    const setPw = await authedFetch(session.cookie, "/api/register/password-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: `e2e-seq-${Date.now()}` }),
    });
    assert.equal(setPw.status, 200, "password-set failed");

    // 3. Complete the profile (completeRegistration's client Firestore write).
    await seedPendingUserDoc(ledger, {
      uid: session.uid,
      email: session.email,
      universityEmail: uniEmail,
    });

    // 4. completeRegistration's reconcile call, on the SAME cookie the browser
    //    still holds — it never re-establishes the session in between.
    const reconcile = await authedFetch(session.cookie, "/api/verify-email/reconcile", {
      method: "POST",
    });

    const user = await readUserDoc(session.uid);
    assert.ok(
      user?.profile?.uniEmailVerifiedAt,
      `uniEmailVerifiedAt did NOT land (reconcile returned ${reconcile.status}). ` +
        "In the real flow completeRegistration swallows this failure with a " +
        "console.warn, so the member's university email is silently unattested " +
        "while the admin console and the profile UI both read 'verified'. This " +
        "is the exact gap PR #216 closed, reopened by password-set revoking the " +
        "session cookie that reconcile authenticates with.",
    );
  });
});
