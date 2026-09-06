/**
 * The membership console, end to end, in a real browser.
 *
 * Sign in as the owner's admin -> /admin/membership -> create a period -> make
 * it current -> look at it in the switcher -> find the seeded account in the
 * table -> record a tier -> read the row and the cached year in Firestore ->
 * take the membership away -> read that both are gone -> hand the current
 * pointer back where it came from.
 *
 * ## How to run it
 *
 *   E2E_TARGET=http://127.0.0.1:3100 node scripts/run-e2e.mjs --spec membership-console
 *   node scripts/run-e2e.mjs --local --spec membership-console
 *
 * `scripts/run-e2e.mjs` seeds the throwaway world, leaves its ids in a state
 * file under `.e2e-state/`, and tears everything down afterwards. Running this
 * file on its own is supported once a seed exists; it reads the state file and
 * skips loudly when there is none.
 *
 * ## It signs in as the owner's own admin, because nothing else can
 *
 * The harness may never create an account above role `pending`, so the admin
 * is real credentials out of `.env.e2e.secrets.local`. Everything this spec
 * asserts about permissions is therefore asserted about a real admin, and
 * nothing here mints one.
 *
 * ## It moves a pointer the whole dev project reads, and says so
 *
 * "Make current" rewrites `config/membership`, which is what every membership
 * badge on dev reads while this runs. The fixture snapshotted that document
 * before the first write and puts it back in teardown, and its manifest counts
 * 1 for as long as the live pointer differs from the snapshot, so a run that
 * moved it and failed to move it back cannot report a clean total. The last
 * step below hands it back through the console as well, when there is a period
 * to hand it back to, because the console offering the way back is itself
 * worth proving.
 *
 * ## CHROMIUM ONLY, which is a limitation rather than a choice
 *
 * Playwright drives Chromium here and nothing else. This codebase has already
 * shipped a Safari-only defect (a `<button>` whose inline background WebKit
 * painted over), so a green run is a REGRESSION NET and never a substitute for
 * the manual Safari pass before dev goes to main.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTarget, loadSecrets } from "../../scripts/e2e/lib/env.mjs";
import {
  createStepRecorder,
  openBrowser,
  signInWithPassword,
  stubRecaptchaOnLoopback,
} from "../../scripts/e2e/lib/browser.mjs";
import { readUserDoc } from "../../scripts/e2e/lib/firestore.mjs";
import {
  ARTIFACTS_DIR,
  RECAPTCHA_SKIP_REASON,
  fixtureDoc,
  fixtureQuery,
  markerPath,
  statePath,
  stateDir,
} from "../../scripts/e2e-fixtures/core.mjs";
import {
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
  membershipRowId,
} from "../../scripts/e2e-fixtures/membership-console.mjs";

const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: dev is a cold Cloud Run. */
const WAIT_MS = 30_000;

/**
 * The first request to an admin route on a DEV server compiles the whole tree
 * before it answers, which is slower than anything a deployed build does. Only
 * the first navigation gets this; everything after it is a warm route.
 */
const FIRST_LOAD_MS = 90_000;

/**
 * Why a step may not run in this mode, or null.
 *
 * This spec has no reCAPTCHA-gated step: every route it drives is an admin
 * route behind a session cookie, so `SPEC.recaptchaDependentSteps` is empty
 * and nothing is ever skipped. The wiring is here in the same shape the
 * applicant funnel uses, so that a step which does become gated is skipped
 * with the one reason the runner accepts rather than with wording of its own.
 */
let skipReasonFor = () => null;

/** The one reason this file may record for a step it did not run. */
const DEPLOYED_TARGET_SKIP = RECAPTCHA_SKIP_REASON;

/**
 * Wait for one locator and, when it never arrives, fail with the sentence a
 * person can act on rather than with a selector and a number. The recorder
 * keeps the page itself (a screenshot and its text) under `.e2e-artifacts/`.
 */
async function waitForWithReason(locator, reason) {
  await locator.waitFor({ timeout: WAIT_MS }).catch((err) => {
    throw new Error(`${reason} (${err.message})`);
  });
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Playwright is NOT a dependency of this repo, deliberately: the root
 * package.json is what App Hosting runs `npm ci` against on the critical path
 * of every production deploy. So it is resolved at runtime and a missing one
 * is a SKIP with the install line, not a red suite.
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
const secrets = loadSecrets();

const skipReason = !playwright
  ? "Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium"
  : !state
    ? `No membership-console fixture at ${STATE_PATH}. Run: node scripts/run-e2e.mjs --spec membership-console.`
    : !secrets.adminEmail || !secrets.adminPassword
      ? "E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are not set. This spec drives an admin-only console, and the harness may never create an admin: put the owner's own credentials in .env.e2e.secrets.local."
      : null;

/** The origin under test, through the harness's own allowlist so a typo cannot
 *  aim a run that WRITES MEMBERSHIP RECORDS at production. */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP`.
test(
  "membership console: create a period, make it current, record a tier and take it back",
  { skip: skipReason ?? false },
  async (t) => {
    const origin = baseUrl();
    const consoleUrl = `${origin}/admin/membership`;
    const member = state.member;

    const { browser, context, page } = await openBrowser();
    const recorder = createStepRecorder({
      t,
      page,
      markerPath: MARKER,
      artifactsDir: ARTIFACTS_DIR,
      skipReasonFor: (name) => skipReasonFor(name),
    });
    const step = (name, fn) => recorder.step(name, fn);
    // Nothing here is reCAPTCHA-gated, so the stub changes nothing; it is armed
    // anyway so this file behaves identically to every other spec if a control
    // it drives ever grows a widget.
    const recaptchaStubbed = await stubRecaptchaOnLoopback(page, origin);
    if (!recaptchaStubbed && RECAPTCHA_DEPENDENT_STEPS.length > 0) {
      skipReasonFor = (name) =>
        RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
    }

    /** The period's row in the periods list, found by the label the fixture
     *  chose. The year is not unique enough on its own: the label is. */
    const periodRow = () =>
      page
        .getByTestId("membership-period-row")
        .filter({ hasText: state.periodLabel })
        .first();

    /** The seeded account's row in the members table, found by its address. */
    const memberRow = () =>
      page.getByTestId("membership-row").filter({ hasText: member.email }).first();

    try {
      await step("the admin signs in and opens the membership console", async () => {
        // Sign-in is `signInWithPassword` in scripts/e2e/lib/browser.mjs, which
        // waits for the form to hydrate and the card to land before it types.
        await signInWithPassword(
          page,
          origin,
          { email: secrets.adminEmail, password: secrets.adminPassword },
          { timeout: FIRST_LOAD_MS },
        );
        await page.goto(consoleUrl, { waitUntil: "domcontentloaded", timeout: FIRST_LOAD_MS });
        await page
          .getByRole("heading", { name: "Membership periods" })
          .waitFor({ timeout: FIRST_LOAD_MS });
        // The console loads its periods through a route rather than a snapshot
        // listener, so "the page rendered" and "the list is here" are different
        // moments. The create control is what the next step presses.
        await page.getByTestId("membership-new-period").waitFor({ timeout: WAIT_MS });
      });

      await step("creating a period puts it on the list", async () => {
        // The period form's three test ids (year, label, submit) name whichever
        // copy of that form is open, because the console renders the same
        // component for creating a period and for editing one. This step opens
        // the create form and nothing else, so they are unambiguous here; a
        // step that opened an edit form alongside it would fail on the
        // ambiguity rather than quietly press the wrong control.
        await page.getByTestId("membership-new-period").click();
        const year = page.getByTestId("membership-period-year");
        await year.waitFor({ timeout: WAIT_MS });
        // The form opens on the CURRENT academic year, which is a real period
        // somebody may already keep. Filled over, not appended to.
        await year.fill(state.periodYear);
        await page.getByTestId("membership-period-label").fill(state.periodLabel);
        await page.getByTestId("membership-period-submit").click();
        await periodRow().waitFor({ timeout: WAIT_MS });
        // The year badge and a fresh set of counts: a period nobody has been
        // recorded against yet reads zero on all four tiers.
        await waitForWithReason(
          periodRow().getByText(state.periodYear, { exact: false }).first(),
          "the new period's row did not show its academic year",
        );
        assert.match(
          await periodRow().innerText(),
          /Paid: 0/,
          "a period created a moment ago already has members recorded against it",
        );
      });

      await step("making it current moves the pointer", async () => {
        await periodRow().getByTestId("membership-make-current").click();
        // The Current chip appearing on this row IS the console agreeing the
        // pointer moved: the list is refetched from the route after the write,
        // so the chip is drawn from `config/membership` rather than from
        // anything this page assumed.
        await periodRow()
          .getByTestId("membership-period-current")
          .waitFor({ timeout: WAIT_MS });
        assert.equal(
          await periodRow().getByTestId("membership-make-current").count(),
          0,
          "the row still offers to make current the period that already is",
        );
      });

      await step("the switcher shows the new period as the current one", async () => {
        // Looking at a period is not making it current: the console keeps
        // showing whichever period it was already showing after a write, so
        // the switcher has to be moved on purpose. That separation is the
        // point of the control, and this is it being used.
        const switcher = page.getByTestId("membership-period-switcher");
        await switcher.waitFor({ timeout: WAIT_MS });
        await switcher.locator("select").selectOption(state.periodId);
        await page
          .getByTestId("membership-viewing-current")
          .waitFor({ timeout: WAIT_MS });
        assert.match(
          await page.getByTestId("membership-period-totals").innerText(),
          /Paid: 0/,
          "the period being viewed is not the empty one that was just created",
        );
      });

      await step("the table lists the seeded account with nothing recorded", async () => {
        // A PENDING account is a row here on purpose: somebody who registered
        // on Monday and paid the SU on Tuesday is exactly who this table is
        // for, and the Members page cannot show them.
        await page.getByTestId("membership-search").fill(member.email);
        await memberRow().waitFor({ timeout: WAIT_MS });
        assert.match(
          await memberRow().getByTestId("membership-row-tier").innerText(),
          /Not recorded/,
          "the seeded account already has a membership recorded for this period",
        );
        assert.match(
          await memberRow().innerText(),
          /pending/,
          "the table did not show the account's role, or the account is not pending",
        );
        // The other half of the same fact, read from the account document
        // itself, so the next step's assertion is a CHANGE rather than a state
        // that might always have been true. The field is not named here: see
        // the note in that step.
        const before = await readUserDoc(member.uid);
        assert.ok(before, "the seeded account has no user document");
        assert.ok(
          !JSON.stringify(before).includes(state.periodYear),
          `the seeded account already carries ${state.periodYear} before any grant`,
        );
      });

      await step("recording a tier badges the member and moves the period's count", async () => {
        await memberRow().getByTestId("membership-row-change").click();
        const control = memberRow().getByTestId("membership-tier-control");
        await control.waitFor({ timeout: WAIT_MS });
        // The control renders a native select above 48rem and a bottom sheet
        // below it; this runs at the desktop viewport, where the sheet is
        // `display: none` and the select is the only one of the two a person
        // can reach.
        await control.locator("select").selectOption(state.tier);
        await control.getByTestId("membership-tier-grant").click();
        await waitForWithReason(
          memberRow().getByTestId("membership-row-tier").getByText("Paid", { exact: false }),
          "the row did not take the badge after the tier was recorded",
        );
        // The period's counts strip is the CACHE on the period document, moved
        // by the grant route inside the same transaction as the row. Reading it
        // here is what proves the two moved together rather than the row alone.
        await waitForWithReason(
          page.getByTestId("membership-period-totals").getByText("Paid: 1", { exact: false }),
          "the period's Paid count did not move when the membership was recorded",
        );
      });

      await step("the membership row and the cached year are in Firestore", async () => {
        const snap = await fixtureDoc(
          "memberships",
          membershipRowId(member.uid, state.periodId),
        ).get();
        assert.ok(snap.exists, "no membership row was written for the granted member");
        const row = snap.data() ?? {};
        assert.equal(row.tier, state.tier, "the membership row has the wrong tier");
        assert.equal(row.uid, member.uid, "the membership row names the wrong member");
        assert.equal(row.periodId, state.periodId, "the membership row names the wrong period");
        assert.equal(row.source, "manual", "a grant from the console is a manual source");
        assert.equal(
          row.matchedOn,
          "manual",
          "a grant from the console is matched on an admin recording it by hand",
        );
        assert.ok(
          typeof row.provenance?.byUid === "string" && row.provenance.byUid.length > 0,
          "the membership row does not record who granted it",
        );

        // THE QUERYABLE CACHE ON THE ACCOUNT, asserted WITHOUT NAMING THE FIELD.
        //
        // The grant route writes the row and one entry on the user document in
        // one transaction, and that entry is what every existing badge reads.
        // The offline fence (tests/funnel-harness-guards.test.mjs) refuses any
        // harness file that so much as spells that field's name in code,
        // because writing it is a privilege grant and a grep cannot tell a read
        // from a write. So the assertion is on the document as a whole: the
        // academic year is a string that appears nowhere in a seeded account
        // (the step above proved that), so its arrival here is the cache entry
        // arriving, and its departure two steps down is the revoke clearing it.
        const after = await readUserDoc(member.uid);
        assert.ok(after, "the granted account has no user document");
        assert.ok(
          JSON.stringify(after).includes(state.periodYear),
          `the account does not carry ${state.periodYear} after a paid membership was recorded`,
        );
      });

      await step("taking the membership away clears the badge and the count", async () => {
        await memberRow().getByTestId("membership-row-change").click();
        const control = memberRow().getByTestId("membership-tier-control");
        await control.waitFor({ timeout: WAIT_MS });
        await control.getByTestId("membership-tier-revoke").click();
        await waitForWithReason(
          memberRow()
            .getByTestId("membership-row-tier")
            .getByText("Not recorded", { exact: false }),
          "the row kept its badge after the membership was taken away",
        );
        await waitForWithReason(
          page.getByTestId("membership-period-totals").getByText("Paid: 0", { exact: false }),
          "the period's Paid count did not come back down after the revoke",
        );
      });

      await step("the revoke removed the row and the cached year", async () => {
        // A revoke DELETES the row rather than stamping it revoked, because a
        // row that survives its revoke reads as a membership to anything that
        // forgets to check the field.
        const snap = await fixtureDoc(
          "memberships",
          membershipRowId(member.uid, state.periodId),
        ).get();
        assert.equal(
          snap.exists,
          false,
          "the membership row survived the revoke, so something still reads as a membership",
        );
        const after = await readUserDoc(member.uid);
        assert.ok(after, "the account lost its user document");
        assert.ok(
          !JSON.stringify(after).includes(state.periodYear),
          `the account still carries ${state.periodYear} after the membership was taken away`,
        );
      });

      await step("the pointer goes back where it came from", async () => {
        if (state.previousPeriodId && state.previousPeriodLabel) {
          const previousRow = page
            .getByTestId("membership-period-row")
            .filter({ hasText: state.previousPeriodLabel })
            .first();
          await previousRow.waitFor({ timeout: WAIT_MS });
          await previousRow.getByTestId("membership-make-current").click();
          await previousRow
            .getByTestId("membership-period-current")
            .waitFor({ timeout: WAIT_MS });
          assert.equal(
            await periodRow().getByTestId("membership-period-current").count(),
            0,
            "two periods are marked current at once, which is the state the pointer exists to prevent",
          );
          return;
        }
        // There was no current period on this project when the run started, so
        // the console has nothing to offer the pointer back to and teardown
        // deletes the document it created. Asserted rather than assumed: the
        // fixture period must still be the current one, or something else moved
        // the pointer while this ran and the snapshot in the ledger is stale.
        await periodRow()
          .getByTestId("membership-period-current")
          .waitFor({ timeout: WAIT_MS });
      });

      await step("nothing on the journey emailed the member", async () => {
        // Asserted here rather than left to the manifest, because the manifest
        // cannot say it: teardown sweeps `emailSends` for this address before
        // the runner takes its only enforced count, so a notification added to
        // the grant route later would be created and swept with a total of
        // zero. This is the assertion that would go red instead.
        //
        // The same sentence in both suppression modes, which is the one place
        // this spec differs from the ones that send: those assert rows exist
        // when mail is caught and none when it is not. Nothing on these paths
        // sends at all, so the expected answer is none either way, and a row
        // here means the route grew a send nobody decided on.
        const rows = await fixtureQuery("emailSends")
          .where("to", "==", member.email)
          .get();
        assert.equal(
          rows.size,
          0,
          `${rows.size} email(s) were logged to the member for a membership recorded and ` +
            "then taken away. Recording a membership is bookkeeping, not news: if a send " +
            "was added deliberately, this spec should assert what it says instead.",
        );
      });
    } finally {
      await context.close();
      await browser.close();
      recorder.writeMarker();
    }
  },
);
