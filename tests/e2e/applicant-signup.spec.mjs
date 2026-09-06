/**
 * Joining NAISI from an apply link, end to end, in a real browser.
 *
 * The signed-out gate on /apply/[roundId] -> /login carrying the round as its
 * return address -> switch to Create account -> give an email -> read the
 * confirmation out of the inbox and drive its link -> set a password -> the
 * profile form -> verify a university email through a second emailed link ->
 * fill the form in -> land back on the apply page as a role-pending account
 * that is offered the application.
 *
 * The `__auth_next` cookie is deleted before the emailed link is driven, so
 * the last step proves the return address survives on the verification token
 * itself. That is the shape a real journey has: the confirmation email is
 * routinely opened on a phone, where no cookie of ours has ever existed.
 *
 * ## Nothing here is seeded except the round
 *
 * The fixture creates ONE admission round. The account is the product's to
 * make: `/api/register` creates the Auth user, the magic link verifies it and
 * mints the session, `/api/register/password-set` gives it a credential, and
 * the register form's own write creates `users/{uid}` at role `pending`. That
 * is the whole point of this spec, and it is why it cannot borrow the funnel's
 * seeded accounts: a seeded account would skip every one of those legs and
 * leave this proving that a form renders.
 *
 * ## LOCAL MODE ONLY, and that is a property rather than a limitation
 *
 * Two of the steps below make the server SEND, and the second send goes to an
 * `@nottingham.ac.uk` address, which is a real domain. So every step but the
 * first is on the fixture's `RECAPTCHA_DEPENDENT_STEPS` and is skipped against
 * a deployed target, and before the university address is typed anywhere the
 * spec PROVES a `.invalid` message really reached the local Mailpit. That is
 * the same gate scripts/e2e/tests/uni-email-inbox.test.mjs applies, for the
 * same reason: an env var saying "a runner started me" is a promise, and a
 * message sitting in the catcher is a fact.
 *
 * The register press additionally refuses to run at all unless the RUNNER said
 * this run's mail is caught. `http://127.0.0.1:3000` is on the harness target
 * allowlist and is the ordinary `npm run dev` port, whose server carries the
 * real Resend credentials: loopback is not the same fact as caught, and this
 * spec is the one that would hand a real sender two fixture addresses.
 *
 * ## How to run it
 *
 *   npm run e2e:browser -- --local --spec applicant-signup
 *   E2E_TARGET=http://127.0.0.1:3100 MAILPIT_URL=http://127.0.0.1:8025 \
 *     node scripts/run-e2e.mjs --spec applicant-signup   # against a server
 *                                                        # already running
 *
 * ## CHROMIUM ONLY
 *
 * Playwright drives Chromium here and nothing else, and this codebase has
 * already shipped a Safari-only defect (a `<button>` whose inline background
 * WebKit painted its own grey face over). Google sign-in is not automatable at
 * all by design, so the Google half of this screen is untested by construction.
 * A green run is a REGRESSION NET, never a substitute for the manual Safari
 * pass before dev goes to main.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTarget } from "../../scripts/e2e/lib/env.mjs";
import { harnessUserByEmail } from "../../scripts/e2e/lib/admin.mjs";
import { readUserDoc } from "../../scripts/e2e/lib/firestore.mjs";
import {
  createStepRecorder,
  openBrowser,
  stubRecaptchaOnLoopback,
  waitForRecaptchaWidget,
} from "../../scripts/e2e/lib/browser.mjs";
import {
  getMessage,
  hrefUrls,
  proveSmtpReachesMailpit,
  waitForMessagesTo,
} from "../../scripts/e2e/lib/mailpit.mjs";
import {
  ARTIFACTS_DIR,
  RECAPTCHA_SKIP_REASON,
  fixtureQuery,
  markerPath,
  statePath,
  stateDir,
} from "../../scripts/e2e-fixtures/core.mjs";
import {
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
} from "../../scripts/e2e-fixtures/applicant-signup.mjs";

/**
 * Where this run's ledger and marker live. The runner hands every child an
 * `E2E_STATE_DIR`, and `stateDir()` is the one place that reads it; a
 * hand-driven `node --test` on this file alone falls back to the directory the
 * fixture writes to by default.
 */
const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: the shared harness server
 *  runs `next dev`, which compiles each route on its first request. */
const WAIT_MS = 30_000;

/**
 * How long a message may take to reach Mailpit. Longer than the library's own
 * default because the send is downstream of a route that is being compiled for
 * the first time on this server, and a mail wait that expires while the page
 * is still rendering reports "the send failed" for a request that had not
 * happened yet.
 */
const MAIL_WAIT_MS = 30_000;

/**
 * Why a step may not run in this mode, or null. Decided once the target is
 * known: against a deployed target the real widget challenges headless
 * Chromium and the sends would be real, so the whole registration leg is
 * local-mode only. See `RECAPTCHA_DEPENDENT_STEPS` in the fixture module.
 */
let skipReasonFor = () => null;

/**
 * The one reason this file may record for a step it did not run, shared with
 * the runner through `core.mjs`. The runner accepts a skip only when the step
 * is reCAPTCHA-dependent AND the marker carries this exact reason, so a step
 * skipped for anything else is a shortfall rather than an accepted gap.
 */
const DEPLOYED_TARGET_SKIP = RECAPTCHA_SKIP_REASON;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Playwright is NOT a dependency of this repo, deliberately: the root
 * `package.json` is what App Hosting runs `npm ci` against on the critical
 * path of every production deploy. So it is resolved at runtime and a missing
 * one is a SKIP with the install line, not a red suite.
 */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

const state = loadState();
const playwright = await loadPlaywright();

const skipReason = !playwright
  ? "Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium"
  : !state
    ? `No signup fixture at ${STATE_PATH}. Run: node scripts/run-e2e.mjs --spec applicant-signup.`
    : null;

/**
 * The origin under test, through the auth harness's own allowlist so a typo
 * cannot aim a run that CREATES ACCOUNTS at production.
 */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

/** The one verification link in an email body, asserted to be unambiguous. */
function verificationLink(message, origin) {
  const links = [
    ...new Set(hrefUrls(message.HTML).filter((l) => l.startsWith(`${origin}/verify-email/`))),
  ];
  assert.equal(
    links.length,
    1,
    `expected exactly one ${origin}/verify-email/ link in the email, found ` +
      `${links.length}. Two disagreeing links means the button and the fallback ` +
      "verify different tokens; none means the link points at another origin, " +
      "so NEXT_PUBLIC_APP_URL is not what this server is serving on.",
  );
  return links[0];
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP` and counts
// it as skipped, which reads as a run that never happened.
test(
  "applicant sign-up: join from an apply link, verify both addresses, come back able to apply",
  { skip: skipReason ?? false },
  async (t) => {
    const origin = baseUrl();
    const applyUrl = `${origin}/apply/${encodeURIComponent(state.roundId)}`;

    const { browser, context, page } = await openBrowser();
    const recorder = createStepRecorder({
      t,
      page,
      markerPath: MARKER,
      artifactsDir: ARTIFACTS_DIR,
      // Read through a closure rather than passed by value: the mode is only
      // known once the stub has had its say, a few lines below this.
      skipReasonFor: (name) => skipReasonFor(name),
    });
    const step = (name, fn) => recorder.step(name, fn);
    // Local mode only (the helper checks): /api/register is reCAPTCHA-gated,
    // the harness server holds the always-pass secret, and this hands the
    // widget a token to send.
    const recaptchaStubbed = await stubRecaptchaOnLoopback(page, origin);
    console.log(
      `[signup-spec] reCAPTCHA: ${recaptchaStubbed ? `armed (${recaptchaStubbed})` : "real widget (deployed target)"}`,
    );
    if (!recaptchaStubbed) {
      skipReasonFor = (name) =>
        RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
      console.log(
        `[signup-spec] ${RECAPTCHA_DEPENDENT_STEPS.length} reCAPTCHA-dependent step(s) will be ` +
          "SKIPPED against this target and reported as such. Run with --local to drive them.",
      );
    }

    try {
      await step(
        "a signed-out visitor is offered sign-in and a way to join on the apply page",
        async () => {
          await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
          await page
            .getByRole("heading", { name: "Sign in to apply" })
            .waitFor({ timeout: WAIT_MS });
          // The gate must not render the form behind it. A start button here
          // would mean the page had decided a signed-out visitor could write
          // to the round.
          assert.equal(
            await page.getByRole("button", { name: "Start your application" }).count(),
            0,
            "the signed-out gate rendered the application form",
          );
          // The promise the copy makes, as a link somebody can press: "any
          // account can apply, including one you make in the next minute".
          await page
            .getByRole("link", { name: "Create one" })
            .waitFor({ timeout: WAIT_MS });
        },
      );

      await step(
        "the sign-in link leads to the login form carrying the round as its return address",
        async () => {
          // The link, not the heading: both say the same words, and the
          // heading is what a person reads while the link is what they press.
          await page.getByRole("link", { name: "Sign in to apply" }).click();
          await page.waitForURL((url) => url.pathname === "/login", { timeout: WAIT_MS });
          assert.equal(
            new URL(page.url()).searchParams.get("next"),
            `/apply/${state.roundId}`,
            "the gate sent the visitor to /login without the round as its return " +
              "address, so finishing registration would land them on /pending-approval " +
              "rather than on the form they came to fill in",
          );
          await page.locator("#auth-email").waitFor({ timeout: WAIT_MS });
        },
      );

      await step(
        "switching to Create account and giving an email sends the confirmation",
        async () => {
          // THE REFUSAL. `suppress` is the runner's answer to "could a send
          // from this target reach a real sender", and only `false` means
          // Mailpit catches it. Loopback is NOT that fact: :3000 is on the
          // target allowlist and is the ordinary dev server, which carries the
          // real Resend credentials. This is the spec that would hand it two
          // fixture addresses, so it stops here rather than sending.
          assert.equal(
            state.suppress,
            false,
            "this run's mail is NOT caught by Mailpit, so pressing Continue with " +
              "email would make the server hand a real sender a fixture address. " +
              "Run this spec through scripts/run-e2e.mjs --local, or against the " +
              "reserved harness port.",
          );

          await page
            .getByTestId("auth-mode-toggle")
            .getByRole("radio", { name: "Create account" })
            .click();
          await page.locator("#auth-email").fill(state.loginEmail);
          // The submit is reCAPTCHA-gated and the widget mounts a beat after
          // the mode switch: pressing before it has yields no token and a
          // refusal. A person never wins that race; a spec always does unless
          // it waits.
          await waitForRecaptchaWidget(page, { timeout: WAIT_MS });
          await page.getByTestId("auth-submit").click();
          // The uniform "check your inbox" screen, which is what a person sees
          // whether or not the address was already registered.
          await page
            .getByRole("heading", { name: "Check your inbox" })
            .waitFor({ timeout: WAIT_MS });
          await page
            .getByText(state.loginEmail, { exact: false })
            .first()
            .waitFor({ timeout: WAIT_MS });
        },
      );

      await step("the emailed link confirms the address and asks for a password", async () => {
        const [summary] = await waitForMessagesTo(state.loginEmail, {
          count: 1,
          timeoutMs: MAIL_WAIT_MS,
        });
        const message = await getMessage(summary.ID);
        assert.equal(
          message.Subject,
          "Confirm your email to finish joining NAISI",
          "the register route sent something other than the confirmation email",
        );
        // BURN THE COOKIE FIRST. `__auth_next` is the fallback AuthEntry
        // writes for the Google redirect leg: one browser, ten minutes. A
        // confirmation email is routinely opened on a phone, or after a
        // coffee, so the journey cannot depend on it. The return address now
        // rides on the verification token itself, and clearing the cookie is
        // what makes the assertion two steps below a statement about the
        // token rather than about a cookie that happens to still be there.
        await page.evaluate(() => {
          document.cookie = "__auth_next=; path=/; max-age=0; samesite=lax";
        });
        // Driven from the BODY rather than reconstructed from the token
        // document: the thing worth proving is that the email a person
        // receives carries a working URL for this server.
        await page.goto(verificationLink(message, origin), { waitUntil: "domcontentloaded" });
        // The landing page signs in with a custom token first and only then
        // asks for a password, so this waits through "Signing you in…".
        await page
          .getByRole("heading", { name: "Set your password" })
          .waitFor({ timeout: WAIT_MS });
      });

      await step("setting a password lands on the profile form already signed in", async () => {
        await page.locator("#set-password").fill(state.password);
        await page.getByRole("button", { name: "Set password & continue" }).click();
        await page.waitForURL((url) => url.pathname === "/register", { timeout: WAIT_MS });
        assert.equal(
          new URL(page.url()).searchParams.get("next"),
          `/apply/${state.roundId}`,
          "the magic-link landing page continued to a bare /register, so the only " +
            "thing left holding the return address was the `__auth_next` cookie the " +
            "step above deleted. An email opened on another device, or later than " +
            "that cookie lives, would strand this applicant on /pending-approval",
        );
        // Setting a password revokes the session cookie the magic link minted,
        // so the page re-authenticates before it navigates. This line is what
        // says that worked: the profile step only renders for a signed-in
        // account whose email is verified.
        await page
          .getByText(`Signed in as ${state.loginEmail}`, { exact: false })
          .first()
          .waitFor({ timeout: WAIT_MS });
        await page.locator("#preferredName").waitFor({ timeout: WAIT_MS });
      });

      await step("the university email is verified through its own emailed link", async () => {
        // THE GATE, before a real domain is typed anywhere. The send that
        // proves it already happened: pressing Continue with email above made
        // this server post the confirmation to a `.invalid` address unique to
        // this run, so a message sitting in Mailpit for it can only have been
        // put there by the server under test. Re-triggering would be refused
        // by the register route's 60-second cooldown anyway, which is why the
        // trigger here does nothing.
        const smtpSkip = await proveSmtpReachesMailpit(state.loginEmail, async () => {});
        assert.equal(
          smtpSkip,
          null,
          `refusing to address ${state.uniEmail}: ${smtpSkip}. That is a real domain, ` +
            "and a server whose SMTP is not the local catcher would send for real.",
        );

        await page.locator("#preferredName").fill("E2E signup");
        await page.locator("#universityEmail").fill(state.uniEmail);
        await page.getByTestId("register-uni-send").click();

        const [summary] = await waitForMessagesTo(state.uniEmail, {
          count: 1,
          timeoutMs: MAIL_WAIT_MS,
        });
        const message = await getMessage(summary.ID);
        assert.equal(
          message.Subject,
          "Verify your university email for NAISI",
          "the send route sent the already-registered notice instead of the " +
            "verification email, so this address is verified on another account: " +
            "a previous run's teardown left one behind",
        );

        // A SECOND TAB, because that is what the email asks a person to do.
        // Driving the link in this one would navigate away from a half-filled
        // form, and the assertion that matters is the register tab noticing on
        // its own: it holds an onSnapshot on the verification document and the
        // panel flips without a reload.
        const inbox = await context.newPage();
        try {
          await inbox.goto(verificationLink(message, origin), {
            waitUntil: "domcontentloaded",
          });
          await inbox
            .getByRole("heading", { name: "University email verified" })
            .waitFor({ timeout: WAIT_MS });
        } finally {
          await inbox.close();
        }

        await page.getByTestId("register-uni-verified").waitFor({ timeout: WAIT_MS });
      });

      await step("the completed profile submits and comes back to the apply page", async () => {
        // The native shape of the responsive select, which is the one on
        // screen at this viewport; the bottom-sheet shape is in the DOM too
        // and hidden by CSS above 48rem.
        await page.locator("select[aria-label='Status']").selectOption("undergraduate");
        // Undergraduate is one of STATUSES_WITH_GRADUATION, so the month and
        // year pair appears and the form refuses to submit without it.
        await page.locator("select[aria-label='Month']").selectOption("06");
        await page
          .locator("select[aria-label='Year']")
          .selectOption(String(new Date().getFullYear() + 2));
        await page.locator("#subject").fill("BSc Mathematics");
        await page
          .locator("#motivation")
          .fill(`Signup run ${state.signupRunId}: written by an automated run.`);
        await page.locator("#member-consent").check();
        await page.getByTestId("register-submit").click();
        // The return address rode through registration on the verification
        // token, which is why the cookie could be deleted mid-journey above.
        // Landing anywhere else (in practice /pending-approval) means that
        // hand-off broke and a person who registered from a form is left to
        // find their way back to it.
        await page.waitForURL((url) => url.pathname === `/apply/${state.roundId}`, {
          timeout: WAIT_MS,
        });
      });

      await step(
        "the apply page now offers the application instead of the sign-in gate",
        async () => {
          await page
            .getByRole("button", { name: "Start your application" })
            .waitFor({ timeout: WAIT_MS });
          assert.equal(
            await page.getByRole("heading", { name: "Sign in to apply" }).count(),
            0,
            "the apply page still showed the signed-out gate to an account that had " +
              "just been created and signed in",
          );
        },
      );

      await step(
        "the account exists at role pending and both addresses have send rows",
        async () => {
          const account = await harnessUserByEmail(state.loginEmail);
          assert.ok(
            account,
            `no Auth account exists for ${state.loginEmail} after the whole journey ran`,
          );
          const doc = await readUserDoc(account.uid);
          assert.ok(
            doc,
            "the register form navigated away without writing users/{uid}, so the " +
              "account is an orphan: authenticated, with no membership application " +
              "behind it",
          );
          assert.equal(
            doc.role,
            "pending",
            "a brand-new account came out of registration at a role other than pending",
          );

          // The send log is the evidence a route really sent, and both
          // addresses must carry one: the confirmation to the sign-in address,
          // the verification to the university one.
          for (const address of [state.loginEmail, state.uniEmail]) {
            const rows = await fixtureQuery("emailSends").where("to", "==", address).get();
            assert.ok(
              rows.size >= 1,
              `no emailSends row for ${address}. Mailpit holds the message, so the ` +
                "send happened and the log write is what did not: the deliverability " +
                "tab would show nothing was ever sent to this person.",
            );
          }
        },
      );
    } finally {
      await context.close();
      await browser.close();
      recorder.writeMarker();
    }
  },
);
