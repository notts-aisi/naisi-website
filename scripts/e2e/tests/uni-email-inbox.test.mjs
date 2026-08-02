/**
 * Phase 4, battery 2: enumeration uniformity EXTENDS TO THE INBOX on the
 * uni-email leg — and the one place the flows are allowed to differentiate
 * does so correctly.
 *
 * /api/verify-email/send answers the caller the same way whether the uni
 * email is free or already verified on another account. But the EMAIL differs:
 * the duplicate case sends AlreadyRegisteredEmail (no verify link, a masked
 * hint at the existing sign-in address) instead of VerifyUniEmail. That is
 * deliberate — the differentiated content only reaches the inbox the caller
 * is trying to prove control of. This battery pins both halves:
 *
 *  - the HTTP responses stay structurally indistinguishable, so a future
 *    refactor cannot leak the distinction to the caller;
 *  - the duplicate-case email carries NO verify link (a link there would let
 *    the second account complete verification of an address someone else
 *    owns) and masks the existing account's address rather than printing it;
 *  - the fresh-case email's link is the SAME token the response returned, on
 *    an absolute URL pointing at this server;
 *  - neither body leaks uids, other recipients' addresses, or render artefacts.
 *
 * LOCAL-ONLY, and the gate is a PROOF rather than a promise. This battery makes
 * the server send to `@nottingham.ac.uk`-shaped fixture addresses — a real
 * domain. Against a server whose SMTP is the real credentials in `.env.local`
 * (an operator's own `npm run dev`, which listens on an allowlisted origin)
 * those sends would leave the machine and bounce against the domain
 * production's deliverability depends on.
 *
 * Checking an env var like E2E_LOCAL_TOKEN_SECRET is only a proxy for "run.mjs
 * started this", and an operator debugging by hand can satisfy it while pointed
 * somewhere else. So before ANY real-domain address is used, the battery drives
 * a send to an undeliverable `.invalid` address — harmless under every SMTP
 * configuration — and requires it to appear in Mailpit. If it does not, the
 * server is not sending into the local catcher and the battery skips.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, isLoopbackOrigin, runId } from "../lib/env.mjs";
import { deleteHarnessUser, harnessUserByEmail } from "../lib/admin.mjs";
import {
  createLedger,
  deleteEmailVerificationsFor,
  deleteRegistrationRow,
  seedEmailVerification,
  seedPendingUserDoc,
} from "../lib/firestore.mjs";
import { anonFetch, authedFetch, withHarnessSession } from "../lib/session.mjs";
import { opaqueId, signToken } from "../lib/tokens.mjs";
import {
  getMessage,
  hrefUrls,
  proveSmtpReachesMailpit,
  waitForMessagesTo,
} from "../lib/mailpit.mjs";

/** Mirrors src/lib/obfuscateEmail.ts for the long-local-part case, so the
 *  assertion pins the exact masked form the email should show. */
function expectedMask(email) {
  const at = email.indexOf("@");
  const local = email.slice(0, at);
  return `${local[0]}**${local.slice(-2)}${email.slice(at)}`;
}

describe("uni-email inbox enumeration (Mailpit)", () => {
  let env;
  let skipReason = null;
  let owner; // session A — already owns the uni email, verified
  let claimant; // session B — tries to claim it
  let ledger;
  let uniOwned;
  let uniFresh;
  let dupJson;
  let freshJson;
  /** The `.invalid` address the SMTP-routing proof registered; needs teardown. */
  let probeAddress = null;

  before(async () => {
    env = loadEnv();
    if (!process.env.E2E_LOCAL_TOKEN_SECRET) {
      skipReason =
        "Not started by run.mjs (E2E_LOCAL_TOKEN_SECRET absent). This battery " +
        "makes the server send on the uni-email leg — only run.mjs guarantees " +
        "that lands in Mailpit instead of bouncing against the real domain.";
      return;
    }
    if (!isLoopbackOrigin(env.origin)) {
      skipReason = `Refusing against ${env.origin} — local only.`;
      return;
    }

    const id = runId();
    uniOwned = `e2e-${id}owned@nottingham.ac.uk`;
    uniFresh = `e2e-${id}fresh@nottingham.ac.uk`;
    ledger = createLedger();
    owner = await withHarnessSession(`${id}a`);
    claimant = await withHarnessSession(`${id}b`);

    // THE GATE: prove the server's mail reaches Mailpit, using a `.invalid`
    // address that is undeliverable everywhere, BEFORE any nottingham.ac.uk
    // fixture is used. /api/register is the cheapest route that sends.
    skipReason = await proveSmtpReachesMailpit(
      `e2e-${id}probe@e2e.invalid`,
      async (probe) => {
        probeAddress = probe;
        const res = await anonFetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: probe, recaptchaToken: "e2e-test-token" }),
        });
        if (res.status !== 200) {
          throw new Error(`/api/register answered ${res.status} for the probe`);
        }
      },
    );
    if (skipReason) return;

    // Make `owner` the verified holder of uniOwned, through the real flow:
    // seeded token → confirm → profile doc → reconcile stamps the profile.
    const tokenId = opaqueId();
    await seedEmailVerification(ledger, {
      tokenId,
      email: uniOwned,
      authUid: owner.uid,
    });
    const signed = signToken({ s: "verify-uni-email", v: tokenId }, 1800, env.tokenSecret);
    const confirm = await authedFetch(owner.cookie, "/api/verify-email/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed }),
    });
    assert.equal(confirm.status, 200, "fixture: uni-email confirm failed");
    await seedPendingUserDoc(ledger, {
      uid: owner.uid,
      email: owner.email,
      universityEmail: uniOwned,
    });
    const reconcile = await authedFetch(owner.cookie, "/api/verify-email/reconcile", {
      method: "POST",
    });
    assert.equal(reconcile.status, 200, "fixture: reconcile failed");
  });

  after(async () => {
    if (ledger) await ledger.teardown();
    // Sweep by ADDRESS as well as by ledger. /api/verify-email/send mints or
    // updates the token doc BEFORE it sends and answers 502 without a tokenId
    // if dispatch fails — so a Mailpit hiccup would strand a doc the ledger
    // never learned about.
    for (const address of [uniOwned, uniFresh]) {
      if (address) await deleteEmailVerificationsFor(address).catch(() => {});
    }
    if (probeAddress) {
      const probeUser = await harnessUserByEmail(probeAddress).catch(() => null);
      if (probeUser) {
        await deleteRegistrationRow(probeUser.uid).catch(() => {});
        await deleteHarnessUser(probeUser.uid).catch(() => {});
      }
      await deleteEmailVerificationsFor(probeAddress).catch(() => {});
    }
    if (owner) await owner.dispose().catch(() => {});
    if (claimant) await claimant.dispose().catch(() => {});
  });

  it("the duplicate and fresh cases answer the caller indistinguishably", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const send = (email) =>
      authedFetch(claimant.cookie, "/api/verify-email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, preferredName: "E2E" }),
      });

    const dupRes = await send(uniOwned);
    dupJson = await dupRes.json();
    const freshRes = await send(uniFresh);
    freshJson = await freshRes.json();

    // The route mints a watchable token doc in BOTH cases (that sameness is
    // part of the uniformity) — record them so teardown removes them.
    for (const json of [dupJson, freshJson]) {
      if (typeof json?.tokenId === "string" && json.tokenId.length > 0) {
        ledger.record("emailVerifications", json.tokenId);
      }
    }

    assert.equal(dupRes.status, 200);
    assert.equal(freshRes.status, 200);
    assert.deepEqual(
      Object.keys(dupJson).sort(),
      Object.keys(freshJson).sort(),
      "The two responses carry different fields — that shape difference is an " +
        "enumeration oracle for whether a uni email already has an account.",
    );
    // Compare EVERY field except the deliberately-random tokenId, rather than a
    // hand-listed subset: a whitelist silently stops covering any field a
    // future refactor adds, which is precisely the leak this guards against.
    const withoutToken = (json) => {
      const { tokenId: _ignored, ...rest } = json;
      return rest;
    };
    assert.deepEqual(
      withoutToken(dupJson),
      withoutToken(freshJson),
      "The two responses differ beyond the (random) tokenId — an enumeration signal.",
    );
    assert.ok(dupJson.tokenId && freshJson.tokenId, "Both responses should carry a tokenId.");
    assert.notEqual(dupJson.tokenId, freshJson.tokenId);
  });

  it("only the inbox differentiates — and the duplicate email has NO verify link", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const dupSummaries = await waitForMessagesTo(uniOwned);
    // EXACTLY one, and check them ALL below. Asserting only on the newest
    // message would let a refactor that sent both a VerifyUniEmail *and* the
    // already-registered notice pass, which is the exact leak this guards.
    assert.equal(
      dupSummaries.length,
      1,
      `The duplicate-uni-email case sent ${dupSummaries.length} emails, expected 1. ` +
        "Any additional email to this address is one the caller caused to be sent " +
        "to an inbox they have not proven they control.",
    );
    const dupMessages = await Promise.all(dupSummaries.map((s) => getMessage(s.ID)));

    assert.equal(
      dupMessages[0].Subject,
      "You already have a NAISI account",
      "The duplicate-uni-email case did not send the already-registered notice.",
    );
    const dupLinks = dupMessages.flatMap((m) => hrefUrls(m.HTML));
    assert.ok(
      dupLinks.every((l) => !l.includes("/verify-email/")),
      "An email to the already-claimed address contains a verification link. A " +
        "recipient could complete verification of an address that is already " +
        "attached to someone else's account — this must never carry the link.",
    );
    for (const link of dupLinks) {
      assert.match(link, /^https?:\/\//, `Relative URL in email body: ${link}`);
    }
    assert.ok(
      (dupMessages[0].HTML + dupMessages[0].Text).includes(expectedMask(owner.email)),
      "The masked hint at the existing sign-in address is missing — the " +
        "recipient has no way to work out which account to sign in with.",
    );
  });

  it("the fresh email carries the exact token the response returned, absolutely addressed", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const [freshSummary] = await waitForMessagesTo(uniFresh);
    const fresh = await getMessage(freshSummary.ID);

    assert.equal(fresh.Subject, "Verify your university email for NAISI");
    const links = hrefUrls(fresh.HTML);
    const expectedPrefix = `${env.origin}/verify-email/${freshJson.tokenId}?t=`;
    assert.ok(
      links.some((l) => l.startsWith(expectedPrefix)),
      `No link starting ${expectedPrefix} — the emailed link and the tokenId the ` +
        "register tab watches (via onSnapshot) are out of sync, so the tab would " +
        "never see the verification complete.",
    );
    for (const link of links) {
      assert.match(link, /^https?:\/\//, `Relative URL in email body: ${link}`);
    }
  });

  it("neither email leaks identifiers or renders broken", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const [dupSummary] = await waitForMessagesTo(uniOwned);
    const [freshSummary] = await waitForMessagesTo(uniFresh);
    const dup = await getMessage(dupSummary.ID);
    const fresh = await getMessage(freshSummary.ID);

    const bodies = [
      ["already-registered", dup.HTML + dup.Text],
      ["verify-uni-email", fresh.HTML + fresh.Text],
    ];
    for (const [name, body] of bodies) {
      assert.ok(
        !body.includes(owner.email),
        `${name}: the existing account's FULL sign-in address appears unmasked — ` +
          "that hands whoever typed the uni email the associated personal address.",
      );
      assert.ok(!body.includes(owner.uid), `${name}: leaks the owner's uid.`);
      assert.ok(!body.includes(claimant.uid), `${name}: leaks the caller's uid.`);
      for (const artefact of ["undefined", "[object Object]", "NaN"]) {
        assert.ok(!body.includes(artefact), `${name}: contains "${artefact}".`);
      }
    }
    // The two recipients' addresses must not cross over.
    assert.ok(
      !(dup.HTML + dup.Text).includes(uniFresh),
      "The already-registered email mentions the OTHER recipient's address.",
    );
    assert.ok(
      !(fresh.HTML + fresh.Text).includes(uniOwned),
      "The verification email mentions the OTHER recipient's address.",
    );
  });
});
