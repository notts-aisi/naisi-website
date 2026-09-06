/**
 * Phase 4, battery 1: what /api/register actually PUTS IN THE INBOX.
 *
 * The register response is enumeration-uniform by design, which means the
 * email is the only observable the flow has — and until this battery, nothing
 * asserted on it. Four properties, in value order:
 *
 *  1. The verification email carries a WORKING magic link. The link is
 *     extracted from the captured body and driven, not reconstructed from the
 *     token doc — closing the one gap token-minting cannot: that the email a
 *     user receives contains the right URL for the right server.
 *  2. Re-registering inside the cooldown sends NOTHING (anti email-bomb), and
 *     re-registering a VERIFIED address sends NOTHING (the enumeration
 *     guarantee extends to the inbox) — while both answer the caller
 *     byte-identically to the original register.
 *  3. The account the emailed link verified ends up with a working credential:
 *     password-set → that password signs in. Stated precisely because the seam
 *     matters: driving the link proves it flips `emailVerified` (property 1),
 *     but the session used for password-set is minted by the harness, NOT the
 *     custom token the landing page hands the browser. Extracting that token
 *     would mean parsing it out of an RSC payload, which is brittle enough to
 *     become a flake — so the client's own sign-in handoff stays a manual check.
 *  4. Hygiene: every link is absolute (relative URLs break in mail clients),
 *     and the body renders without `undefined` / `[object Object]` artefacts.
 *
 * LOCAL-ONLY, and gated harder than the enumeration battery: it must know the
 * server's SMTP is the loopback Mailpit, and the only thing that knows that is
 * run.mjs — so it keys off E2E_LOCAL_TOKEN_SECRET, which nothing else sets.
 * `npm run e2e:local` is the supported way to arm it.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, isLoopbackOrigin, runId } from "../lib/env.mjs";
import { adminAuth, deleteHarnessUser, harnessUserByEmail } from "../lib/admin.mjs";
import { deleteEmailVerificationsFor, deleteRegistrationRow } from "../lib/firestore.mjs";
import { anonFetch, authedFetch, sessionCookieForUid } from "../lib/session.mjs";
import { trySignInWithPassword } from "../lib/identity.mjs";
import {
  getMessage,
  hrefUrls,
  mailpitAvailable,
  settleMessagesTo,
  textUrls,
  waitForMessagesTo,
} from "../lib/mailpit.mjs";

const REGISTER = "/api/register";
/** Mirrors COOLDOWN_SECONDS in src/app/api/register/route.ts. */
const COOLDOWN_MS = 60_000;

function registerBody(email) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, recaptchaToken: "e2e-test-token" }),
  };
}

describe("/api/register email flow (Mailpit)", () => {
  let env;
  let skipReason = null;
  let addr;
  let firstResponseBody;
  let verifyUrl;
  let uid;
  /** When the first verification email was sent, for the cooldown window. */
  let firstSentAt = 0;

  before(async () => {
    env = loadEnv();
    if (!process.env.E2E_LOCAL_TOKEN_SECRET) {
      skipReason =
        "Not started by run.mjs (E2E_LOCAL_TOKEN_SECRET absent) — only run.mjs " +
        "guarantees the server's SMTP is the loopback Mailpit. Use `npm run e2e:local`.";
    } else if (!env.allowRegister || !isLoopbackOrigin(env.origin)) {
      skipReason = "Needs E2E_ALLOW_REGISTER=1 and a loopback target — see run.mjs.";
    } else if (!(await mailpitAvailable())) {
      skipReason = "Mailpit is not answering on MAILPIT_URL.";
    }
    addr = `e2e-${runId()}mail@e2e.invalid`;
  });

  after(async () => {
    const routeUser = await harnessUserByEmail(addr).catch(() => null);
    if (routeUser) {
      await deleteRegistrationRow(routeUser.uid).catch(() => {});
      await deleteHarnessUser(routeUser.uid).catch(() => {});
    }
    await deleteEmailVerificationsFor(addr).catch(() => {});
  });

  it("a fresh registration produces exactly one well-formed verification email", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const res = await anonFetch(REGISTER, registerBody(addr));
    firstSentAt = Date.now();
    firstResponseBody = await res.text();
    assert.equal(res.status, 200, `register returned ${res.status}: ${firstResponseBody}`);

    const [summary] = await waitForMessagesTo(addr);
    const msg = await getMessage(summary.ID);

    assert.equal(msg.Subject, "Confirm your email to finish joining NAISI");
    assert.equal(
      msg.From?.Address,
      "e2e-sender@e2e.invalid",
      "The From address is not the one run.mjs configured — this server's SMTP " +
        "env is not the one the runner constructed.",
    );

    const links = hrefUrls(msg.HTML);
    assert.ok(links.length > 0, "The HTML body contains no links at all.");
    for (const link of links) {
      assert.match(
        link,
        /^https?:\/\//,
        `Relative URL in the email body: ${link} — mail clients have no origin to resolve it against.`,
      );
    }

    const verifyLinks = links.filter((l) => l.startsWith(`${env.origin}/verify-email/`));
    assert.ok(
      verifyLinks.length >= 1,
      `No verification link pointing at ${env.origin} — the email's links go ` +
        `elsewhere (${links.join(", ")}). NEXT_PUBLIC_APP_URL was not baked into ` +
        "this build the way run.mjs intends.",
    );
    // Button + plain-text fallback must agree with each other and with the
    // text body — a mismatch means one of them verifies a different token.
    assert.equal(new Set(verifyLinks).size, 1, "The email's verify links disagree with each other.");
    [verifyUrl] = verifyLinks;
    assert.ok(
      textUrls(msg.Text).some((l) => l === verifyUrl),
      "The plain-text body's link differs from the HTML one.",
    );

    // BOTH parts. sendEmail renders them independently — `render(react)` and
    // `render(react, { plainText: true })` — so a broken prop can surface in
    // one and not the other, and the HTML part is what most recipients see.
    for (const artefact of ["undefined", "[object Object]", "NaN"]) {
      for (const [part, body] of [
        ["text", msg.Text],
        ["html", msg.HTML],
      ]) {
        assert.ok(
          !body.includes(artefact),
          `The ${part} part contains "${artefact}" — a template prop is broken.`,
        );
      }
    }
    // \s? because the plain-text pipeline renders the JSX expression boundary
    // in "{expiresInMinutes} minutes" without its space ("10minutes"), a
    // cosmetic artefact of @react-email/render's html-to-text pass that only
    // text-mode mail clients ever see. The HTML part renders correctly. Found
    // by this battery on 2026-08-02; tolerated rather than asserted-on so the
    // suite tests substance, not the text pipeline's whitespace habits.
    //
    // Ten, not thirty: the copy is computed from TOKEN_TTL_SECONDS, so a
    // number here that disagrees with the route is a promise the link cannot
    // keep. See that constant's comment for why it is short.
    assert.match(msg.Text, /10\s?minutes/, "The expiry copy did not render.");
  });

  it("re-registering inside the cooldown answers identically and sends nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const res = await anonFetch(REGISTER, registerBody(addr));
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(
      body,
      firstResponseBody,
      "The cooldown-suppressed branch answers differently from the send branch — " +
        "that difference is an enumeration signal.",
    );
    const seen = await settleMessagesTo(addr);
    // The route's cooldown is 60s from the first send, so this assertion is only
    // meaningful if we are still inside it. Say so when we are not, rather than
    // reporting a machine that stalled as an email-bomb vulnerability.
    const elapsed = Date.now() - firstSentAt;
    if (seen.length !== 1 && elapsed >= COOLDOWN_MS) {
      return t.skip(
        `Inconclusive: ${Math.round(elapsed / 1000)}s elapsed since the first send, ` +
          "past the route's 60s cooldown, so a second email is correct behaviour. " +
          "The machine stalled mid-suite — rerun.",
      );
    }
    assert.equal(
      seen.length,
      1,
      `Expected the original email only, found ${seen.length} — the cooldown is ` +
        "not suppressing re-sends, so a register-POST flood can email-bomb any address.",
    );
  });

  it("driving the emailed link verifies the address", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const page = await fetch(verifyUrl);
    const html = await page.text();
    assert.equal(page.status, 200, `GET ${verifyUrl} returned ${page.status}`);
    assert.ok(
      !html.includes("verify this link"),
      "The magic-link landing page rendered its error state for the link the " +
        "email actually carried.",
    );

    const routeUser = await harnessUserByEmail(addr);
    assert.ok(routeUser, "No Auth account exists for the registered address.");
    uid = routeUser.uid;
    const record = await adminAuth().getUser(uid);
    assert.equal(
      record.emailVerified,
      true,
      "Clicking the emailed link did not flip emailVerified — the emailed URL " +
        "does not actually verify the account it was sent for.",
    );
  });

  it("re-registering a VERIFIED address answers identically and sends nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const res = await anonFetch(REGISTER, registerBody(addr));
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(
      body,
      firstResponseBody,
      "The verified-account branch answers differently from the fresh branch.",
    );
    const seen = await settleMessagesTo(addr);
    assert.equal(
      seen.length,
      1,
      "A verified address received mail on re-register. The HTTP response hides " +
        "account state; the inbox must not reveal it to whoever typed the address.",
    );
  });

  it("the verified account ends in a password that actually signs in", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.ok(uid, "Previous step did not resolve the account.");

    const cookie = await sessionCookieForUid(uid);
    const chosen = `e2e-pw-${runId()}`;
    const set = await authedFetch(cookie, "/api/register/password-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: chosen }),
    });
    assert.equal(set.status, 200, `password-set returned ${set.status}`);

    const signIn = await trySignInWithPassword(addr, chosen);
    assert.equal(
      signIn.ok,
      true,
      `The freshly-set password is refused (${signIn.reason}) — the register → ` +
        "verify → password chain does not produce a working credential.",
    );
  });
});
