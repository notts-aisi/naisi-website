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
import {
  authedFetch,
  sessionCookieFromIdToken,
  withHarnessSession,
} from "../lib/session.mjs";
import { trySignInWithPassword } from "../lib/identity.mjs";
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
 * password-set.test.mjs). This battery found that the stamp was therefore
 * silently lost — reconcile 401'd and `completeRegistration` swallows the
 * failure — defeating PR #216's fix for the whole email/password flow while
 * every UI surface still read "verified". Fixed in PR #221 by re-establishing
 * the session before continuing; the sequence below mirrors what the patched
 * client now does, so it guards the recovery path.
 *
 * NOT covered here: the client change itself. This harness drives HTTP, not a
 * browser, so it proves the server accepts the recovery — a manual pass
 * through registration is still what proves the component does it.
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

  it("stamps uniEmailVerifiedAt even after the password has been set", async (t) => {
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
    //    This revokes the cookie used above.
    const chosen = `e2e-seq-${Date.now()}`;
    const setPw = await authedFetch(session.cookie, "/api/register/password-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: chosen }),
    });
    assert.equal(setPw.status, 200, "password-set failed");

    // 3. Re-establish the session, as the patched LoginEmailVerified now does
    //    before it navigates. Without this the cookie is dead and step 5 401s.
    const reauth = await trySignInWithPassword(session.email, chosen);
    assert.equal(reauth.ok, true, `re-authentication failed: ${reauth.reason}`);
    const freshCookie = await sessionCookieFromIdToken(reauth.idToken);

    // 4. Complete the profile (completeRegistration's client Firestore write).
    await seedPendingUserDoc(ledger, {
      uid: session.uid,
      email: session.email,
      universityEmail: uniEmail,
    });

    // 5. completeRegistration's reconcile call, on the refreshed session.
    const reconcile = await authedFetch(freshCookie, "/api/verify-email/reconcile", {
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
