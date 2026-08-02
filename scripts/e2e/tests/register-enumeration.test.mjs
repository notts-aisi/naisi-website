/**
 * /api/register must not leak whether an address already has an account.
 * The response has to be byte-identical for a fresh address, an existing
 * unverified one, and an already-verified one. This cannot be eyeballed — the
 * screen looks the same either way — and one added field silently destroys the
 * guarantee.
 *
 * ---------------------------------------------------------------------------
 * SKIPPED BY DEFAULT, and that is not laziness. Two hard blockers:
 *
 * 1. reCAPTCHA. /api/register is gated, and verifyRecaptcha() fails CLOSED in
 *    production mode. dev.naisi.uk therefore answers every request here with
 *    the same 400 regardless of account state, so running this against dev
 *    would "pass" while testing nothing. It needs a local server started with
 *    Google's always-pass test secret — that is Phase 3 of the design brief,
 *    and the brief is explicit that such a server is LOCAL ONLY and must bind
 *    to 127.0.0.1: an open registration endpoint on a public host is a
 *    DKIM-aligned mail relay pointed at production's sending reputation.
 *
 * 2. Real email. The fresh-address branch dispatches a verification email via
 *    the configured SMTP credentials — which are the same sender production
 *    uses. The fixtures are `.invalid` (RFC 2606, no DNS, no inbox) so nothing
 *    can reach a real recipient, but the send is still attempted; prefer SMTP
 *    redirected to a local catcher (Mailpit, Phase 4).
 *
 * `npm run e2e:local` arms it: run.mjs starts exactly that server (loopback
 * bind, always-pass secret in its environment only, SMTP pointed at Mailpit)
 * and sets E2E_ALLOW_REGISTER=1 for the test process.
 *
 * "Loopback target + E2E_ALLOW_REGISTER=1" is NOT sufficient on its own, and
 * the gate below does not stop there. Both are ambient-settable, so
 * `E2E_ALLOW_REGISTER=1 E2E_TARGET=http://127.0.0.1:3000 npm run e2e` would
 * otherwise arm this against an operator's own `npm run dev` — a server whose
 * SMTP is the REAL credentials in .env.local. The fixtures are `.invalid` so
 * no inbox could receive them, but the send would still be ATTEMPTED through
 * production's sender, producing real rejections against the domain whose
 * deliverability the newsletter depends on. So the battery proves the server's
 * mail actually lands in Mailpit before it registers anything.
 * ---------------------------------------------------------------------------
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, isLoopbackOrigin, runId } from "../lib/env.mjs";
import { createHarnessUser, deleteHarnessUser, harnessUserByEmail } from "../lib/admin.mjs";
import { deleteEmailVerificationsFor, deleteRegistrationRow } from "../lib/firestore.mjs";
import { anonFetch } from "../lib/session.mjs";
import { proveSmtpReachesMailpit } from "../lib/mailpit.mjs";

const REGISTER = "/api/register";

/** Captures exactly what a client can observe — never latency (see below). */
async function observable(email) {
  const res = await anonFetch(REGISTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, recaptchaToken: "e2e-test-token" }),
  });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type"),
    retryAfter: res.headers.get("retry-after"),
  };
}

describe("/api/register account enumeration", () => {
  let env;
  let skipReason = null;
  const created = [];
  // Addresses the ROUTE was given. Its fresh branch creates an Auth user, a
  // registrations/{uid} tracker row, and an emailVerifications doc whose id the
  // enumeration-uniform response deliberately hides — teardown finds all three
  // by address instead.
  const routeEmails = [];

  before(async () => {
    env = loadEnv();
    if (!env.allowRegister) {
      skipReason =
        "E2E_ALLOW_REGISTER is not 1 — /api/register is reCAPTCHA-gated and its " +
        "fresh-address branch sends real email. See the header of this file.";
      return;
    }
    if (!isLoopbackOrigin(env.origin)) {
      skipReason =
        `Refusing to exercise /api/register against ${env.origin}. This battery is ` +
        "local-only: a captcha-relaxed registration endpoint on a public host is a " +
        "mail relay aligned with production's sending domain.";
      return;
    }
    // Loopback is necessary but NOT sufficient — an operator's own `npm run dev`
    // is loopback too, and its SMTP is real. Prove the mail lands in the local
    // catcher, with a probe address that is undeliverable under every SMTP
    // configuration, before registering anything else.
    const probe = `e2e-${runId()}probe@e2e.invalid`;
    skipReason = await proveSmtpReachesMailpit(probe, async (address) => {
      routeEmails.push(address);
      const res = await anonFetch(REGISTER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, recaptchaToken: "e2e-test-token" }),
      });
      if (res.status !== 200) {
        throw new Error(`probe register returned ${res.status}`);
      }
    });
  });

  after(async () => {
    for (const email of routeEmails) {
      const routeUser = await harnessUserByEmail(email).catch(() => null);
      if (routeUser) {
        await deleteRegistrationRow(routeUser.uid).catch(() => {});
        await deleteHarnessUser(routeUser.uid).catch(() => {});
      }
      await deleteEmailVerificationsFor(email).catch(() => {});
    }
    for (const uid of created) {
      await deleteHarnessUser(uid).catch(() => {});
    }
  });

  it("returns a byte-identical response for fresh, unverified and verified addresses", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const id = runId();
    // Distinct addresses per run: the per-email throttle is 5 hits / 10 min and
    // its 429 body differs from the uniform one, which would look exactly like
    // an enumeration leak and send someone hunting a bug that isn't there.
    //
    // NON-ACADEMIC addresses, deliberately: /api/register is the personal-email
    // route and rejects anything matching ACADEMIC_DOMAIN_PATTERN with a fixed
    // 400 *before* it looks at account state. Academic fixtures would make all
    // three probes identical for a reason that has nothing to do with
    // enumeration — a test that passes while proving nothing. `.invalid` is
    // also undeliverable, so the fresh branch's send cannot reach an inbox.
    const freshId = `${id}fresh`;
    const unverifiedId = `${id}unverified`;
    const verifiedId = `${id}verified`;

    const a = await createHarnessUser(unverifiedId, { emailVerified: false });
    const b = await createHarnessUser(verifiedId, { emailVerified: true });
    created.push(a.uid, b.uid);

    const fresh = `e2e-${freshId}@e2e.invalid`;
    // The fresh probe makes the route create an account; the unverified probe
    // makes it mint a (re)send token doc. Both need address-based teardown.
    routeEmails.push(fresh, a.email);
    const [freshRes, unverifiedRes, verifiedRes] = [
      await observable(fresh),
      await observable(a.email),
      await observable(b.email),
    ];

    // POSITIVE CONTROL, and the reason this file is not the vacuous pass it
    // was before review: prove the probes actually reached the account-state
    // logic. Every earlier guard (format, academic-domain, throttle,
    // reCAPTCHA) answers 400, so without this a fail-closed captcha or a
    // rejected fixture domain would make all three responses trivially equal
    // and the assertions below meaningless.
    assert.equal(
      freshRes.status,
      200,
      `Expected 200 from a fresh registration, got ${freshRes.status} ` +
        `(${freshRes.body}). The probes never reached the enumeration logic — ` +
        "most likely reCAPTCHA is failing closed (this battery needs a local " +
        "server started with Google's always-pass test secret) or the fixture " +
        "domain is being rejected. The comparisons below cannot detect anything " +
        "until this passes.",
    );

    assert.deepEqual(
      unverifiedRes,
      freshRes,
      "An existing unverified account is distinguishable from a fresh address.",
    );
    assert.deepEqual(
      verifiedRes,
      freshRes,
      "An already-verified account is distinguishable from a fresh address — " +
        "this is the account-enumeration oracle the uniform response exists to close.",
    );

    // Deliberately NOT asserted: response time. The fresh branch does a
    // createUser plus two Firestore writes plus an SMTP send; the verified
    // branch does one lookup. A timing oracle genuinely exists here, and
    // pretending otherwise with a flaky latency assertion would be worse than
    // documenting it.
  });
});
