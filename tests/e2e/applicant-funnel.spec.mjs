/**
 * The applicant funnel, end to end, in a real browser.
 *
 * Public course page -> the signed-out gate on /apply/[roundId] -> sign in ->
 * start a draft -> save -> reload and resume -> paint the availability grid ->
 * submit -> read the view-only state -> withdraw -> pick it back up -> submit
 * again -> the status hub -> take a pre-course seat -> leave the course.
 *
 * ## How to run it
 *
 *   npm run e2e:funnel            # against the deployed dev backend
 *   npm run e2e:funnel -- --local # against a server the run starts itself
 *
 * `scripts/run-e2e.mjs` seeds the throwaway world, leaves its ids in a state
 * file under `.e2e-state/` (or wherever E2E_STATE_DIR points), and tears
 * everything down afterwards. Running this file on its own is supported
 * (`node --test tests/e2e/applicant-funnel.spec.mjs`) but only once a seed
 * exists: it reads the state file and skips loudly when there is none.
 *
 * ## CHROMIUM ONLY, and that is a limitation rather than a choice
 *
 * Playwright drives Chromium here and nothing else. This codebase has already
 * shipped a Safari-only defect (a `<button>` whose inline background WebKit
 * painted its own grey face over), and Google sign-in is not automatable at
 * all by design. So a green run here is a REGRESSION NET and never a
 * substitute for the manual Safari pass before dev goes to main. Written on
 * the file because a note in a README is not read at 2am.
 *
 * ## Why it signs in with a password rather than a cookie
 *
 * The auth harness can mint a `__session` cookie without a browser, and that
 * is enough for a server component. It is NOT enough here: the session picker
 * and the drop-out card are client islands reading `useAuth()`, so a cookie
 * alone leaves them in their signed-out branch and the enrol leg would test
 * nothing. The seeded accounts therefore carry a password and this spec drives
 * the real `/login` form, which leaves the browser with real Firebase Auth
 * client state AND the cookie the server wants.
 *
 * ## It writes a completion marker, and the runner insists on it
 *
 * Every way this file can decline to run (no Playwright, no fixture, a skip)
 * still exits `node --test` at 0, which is indistinguishable from a pass. So
 * the shared recorder in `scripts/e2e/lib/browser.mjs` records each step as it
 * finishes and writes the list in the `finally`; `scripts/run-e2e.mjs` deletes
 * that file before the run and refuses to report success unless it comes back
 * naming every step in `SPEC.steps` (the list lives in the fixture module, and
 * a guard test pins it against the step names below). A run that opened no
 * browser is a failure, loudly.
 *
 * ## It is one test with ordered steps, not thirteen tests
 *
 * The funnel is a sequence: there is no "withdraw" to check without a
 * submission before it. Independent tests would each have to rebuild the
 * state, which is both slower and a different thing to assert. Sub-tests give
 * the same named output without pretending the steps are independent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTarget } from "../../scripts/e2e/lib/env.mjs";
import {
  createStepRecorder,
  openBrowser,
  signInWithPassword,
  stubRecaptchaOnLoopback,
  waitForHydration,
  waitForRecaptchaWidget,
} from "../../scripts/e2e/lib/browser.mjs";
import {
  ARTIFACTS_DIR,
  RECAPTCHA_SKIP_REASON,
  markerPath,
  statePath,
  stateDir,
} from "../../scripts/e2e-fixtures/core.mjs";
import {
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
  WITHDRAW_WORD,
} from "../../scripts/e2e-fixtures/applicant-funnel.mjs";

/**
 * Where this run's ledger and marker live. The runner hands every child an
 * `E2E_STATE_DIR`, and `stateDir()` is the one place that reads it; a
 * hand-driven `node --test` on this file alone falls back to the directory the
 * fixture writes to by default.
 */
const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: dev is a cold Cloud Run. */
const WAIT_MS = 30_000;

/**
 * Why a step may not run in this mode, or null. Decided once the target is
 * known: against a deployed target the real widget challenges headless
 * Chromium, so the reCAPTCHA-dependent leg is local-mode only. See
 * `RECAPTCHA_DEPENDENT_STEPS` in the fixture module for the full reasoning.
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
 * Playwright is NOT a dependency of this repo, deliberately.
 *
 * The root `package.json` is what App Hosting runs `npm ci` against on the
 * critical path of every production deploy (the same argument that put the
 * rules tests in their own package), and a browser-automation library plus its
 * downloaded Chromium has no business there. So it is resolved at runtime and
 * a missing one is a SKIP with the install line, not a red suite.
 */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

const state = loadState();
// Resolved here only to decide the skip: the browser itself is opened through
// `openBrowser()`, which does its own dynamic import.
const playwright = await loadPlaywright();

const skipReason = !playwright
  ? "Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium"
  : !state
    ? `No funnel fixture at ${STATE_PATH}. Run: npm run e2e:funnel (or node scripts/seed-fake-applicants.mjs up).`
    : null;

/**
 * The origin under test, through the auth harness's own allowlist so a typo
 * cannot aim a run that CREATES APPLICATIONS at production. Resolved lazily so
 * a skipped run never has to have a target at all.
 */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP` and counts
// it as skipped, which reads as a run that never happened.
test("applicant funnel: apply, withdraw, re-apply, enrol, drop out", { skip: skipReason ?? false }, async (t) => {
  const origin = baseUrl();
  const applicant = state.applicants[0];
  const applyUrl = `${origin}/apply/${encodeURIComponent(state.roundId)}`;
  const courseUrl = `${origin}/courses/${encodeURIComponent(state.courseId)}`;

  // The shared opener: Chromium at the desktop viewport, because the
  // availability grid renders one day at a time below 48rem and all seven
  // columns above it, and the painting step below drags down a column that
  // only exists in the wide layout.
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
  // Local mode only (the helper checks): the apply routes are reCAPTCHA-gated,
  // the local server holds the always-pass secret, and this hands the widget
  // a token to send. Against dev the real widget runs against the real secret.
  const recaptchaStubbed = await stubRecaptchaOnLoopback(page, origin);
  console.log(
    `[funnel-spec] reCAPTCHA: ${recaptchaStubbed ? `armed (${recaptchaStubbed})` : "real widget (deployed target)"}`,
  );
  if (!recaptchaStubbed) {
    skipReasonFor = (name) =>
      RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
    console.log(
      `[funnel-spec] ${RECAPTCHA_DEPENDENT_STEPS.length} reCAPTCHA-dependent step(s) will be ` +
        "SKIPPED against this target and reported as such. Run with --local to drive them.",
    );
  }

  try {
    await step("the public course page shows the seeded session slots", async () => {
      await page.goto(courseUrl, { waitUntil: "domcontentloaded" });
      await page.getByText(state.courseTitle, { exact: false }).first().waitFor({ timeout: WAIT_MS });
      for (const name of ["Funnel session A", "Funnel session B"]) {
        await page.getByText(name, { exact: false }).first().waitFor({ timeout: WAIT_MS });
      }
    });

    await step("a signed-out visitor gets the sign-in gate on the apply page", async () => {
      await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Sign in to apply" }).waitFor({ timeout: WAIT_MS });
      // The gate must not render the form behind it. A "Start your
      // application" button here would mean the page had decided a signed-out
      // visitor could write to the round.
      assert.equal(
        await page.getByRole("button", { name: "Start your application" }).count(),
        0,
        "the signed-out gate rendered the application form",
      );
    });

    await step("applicant 1 signs in", async () => {
      await signInWithPassword(page, origin, applicant);
    });

    await step("starting an application opens an editable draft", async () => {
      await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
      // The start button is reCAPTCHA-gated and the widget mounts a beat after
      // the page: pressing before it has yields no token and a refusal. A
      // person never wins that race; a spec always does unless it waits.
      await waitForRecaptchaWidget(page, { timeout: WAIT_MS });
      await page.getByRole("button", { name: "Start your application" }).click();
      await page.locator(`#${state.questionId}-input`).waitFor({ timeout: WAIT_MS });
    });

    const answer = `Funnel run ${state.funnelRunId}: this answer is written by an automated run.`;

    await step("the draft saves", async () => {
      await page.locator(`#${state.questionId}-input`).fill(answer);
      await page.getByRole("button", { name: "Save draft" }).click();
      // The bar's status line is what tells an applicant their work is on the
      // server. Asserting on it rather than on a network response is the point:
      // a save that succeeded silently and left the bar saying "unsaved" is
      // still a bug for the person in the queue at the fair.
      await page.getByText(/Saved at /).waitFor({ timeout: WAIT_MS });
    });

    await step("the draft survives a reload", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const field = page.locator(`#${state.questionId}-input`);
      await field.waitFor({ timeout: WAIT_MS });
      assert.equal(
        await field.inputValue(),
        answer,
        "the saved answer did not come back after a reload",
      );
    });

    await step("the availability grid paints and the marks persist", async () => {
      // Monday (weekday 1), the first eight quarter hours: 09:00 to 11:00.
      const from = page.locator('[data-day="1"][data-slot="0"]');
      const to = page.locator('[data-day="1"][data-slot="7"]');
      await from.waitFor({ timeout: WAIT_MS });
      // The step before this one reloaded the page, and the grid is in the
      // server markup a good while before React attaches to it on a dev
      // server. A drag in that window paints NOTHING and says nothing about
      // why: the run reads back `data-on="false"` on a cell it just dragged
      // across. Same race the sign-in helper waits out, one component along.
      await waitForHydration(page, '[data-day="1"][data-slot="0"]', { timeout: WAIT_MS });
      // Put the MIDDLE of the run in the middle of the viewport first, so both
      // ends of the drag sit well inside it. Fresh from a reload the grid's
      // first row is at the bottom edge of a 900px window, under the sticky
      // draft save bar, and a pointer put down there lands on the bar: nothing
      // paints and the drag selects text down the page. Centring the FIRST
      // cell was enough on a Mac and not on the Linux runner, whose taller
      // rows put the eighth cell back under the bar (6 September 2026: "the
      // drag did not fill through to the last cell", every run). The grid
      // resolves cells with `elementFromPoint`, so whatever is painted on top
      // of a cell wins, and the check below says WHAT is on top rather than
      // leaving a bare false to be reproduced on another machine.
      await page
        .locator('[data-day="1"][data-slot="4"]')
        .evaluate((el) => el.scrollIntoView({ block: "center" }));
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      assert.ok(a && b, "the availability grid did not lay out");
      const under = await page.evaluate(
        ([points]) =>
          points.map(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            const cell = el instanceof Element ? el.closest("[data-day][data-slot]") : null;
            return cell ? `slot ${cell.getAttribute("data-slot")}` : `<${el?.tagName?.toLowerCase() ?? "nothing"}>`;
          }),
        [
          [
            [a.x + a.width / 2, a.y + a.height / 2],
            [b.x + b.width / 2, b.y + b.height / 2],
          ],
        ],
      );
      assert.deepEqual(
        under,
        ["slot 0", "slot 7"],
        `the two ends of the drag are not the cells the pointer will land on: ${under.join(", ")}. ` +
          "Something is painted over the grid there (the sticky save bar, a header), so a " +
          "drag would paint up to the covered cell and stop.",
      );
      // A real pointer drag rather than eight clicks: the drag is the gesture
      // the component is built around (pointer capture, run filling), and
      // clicking each cell would leave that path untested. Three moves per
      // row, so a slow machine coalescing events still visits every cell.
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 24 });
      await page.mouse.up();
      assert.equal(
        await from.getAttribute("data-on"),
        "true",
        "the first cell of the drag did not paint",
      );
      assert.equal(
        await to.getAttribute("data-on"),
        "true",
        "the drag did not fill through to the last cell",
      );

      await page.getByRole("button", { name: "Save draft" }).click();
      await page.getByText(/Saved at /).waitFor({ timeout: WAIT_MS });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-day="1"][data-slot="0"]').waitFor({ timeout: WAIT_MS });
      assert.equal(
        await page.locator('[data-day="1"][data-slot="0"]').getAttribute("data-on"),
        "true",
        "the painted availability did not come back after a reload",
      );
    });

    await step("submitting moves the application to view-only", async () => {
      // Submit sends a token too, and the grid step ended on a reload.
      await waitForRecaptchaWidget(page, { timeout: WAIT_MS });
      await page.getByRole("button", { name: "Submit application" }).click();
      await page.getByRole("heading", { name: "Your application is in" }).waitFor({ timeout: WAIT_MS });
      // View-only means the controls are GONE, not merely disabled: the flow
      // renders a different subtree after submit.
      assert.equal(
        await page.getByRole("button", { name: "Submit application" }).count(),
        0,
        "the submit button survived submission",
      );
      assert.equal(
        await page.locator(`#${state.questionId}-input`).count(),
        0,
        "the answer stayed editable after submission",
      );
      await page.getByText(answer, { exact: false }).first().waitFor({ timeout: WAIT_MS });
    });

    await step("withdrawing needs the typed word and then takes it back", async () => {
      await page.getByRole("button", { name: "Withdraw this application" }).click();
      const confirm = page.getByLabel(`Type ${WITHDRAW_WORD} to confirm`);
      await confirm.waitFor({ timeout: WAIT_MS });
      const withdrawButton = page.getByRole("button", { name: "Withdraw", exact: true });
      assert.equal(
        await withdrawButton.isDisabled(),
        true,
        "the withdraw button was live before the confirmation word was typed",
      );
      await confirm.fill(WITHDRAW_WORD);
      await withdrawButton.click();
      await page
        .getByRole("heading", { name: "You withdrew this application" })
        .waitFor({ timeout: WAIT_MS });
    });

    await step("picking it back up restores the answers and submits again", async () => {
      // Picking it back up is the start route again, so it is gated the same way.
      await waitForRecaptchaWidget(page, { timeout: WAIT_MS });
      await page.getByRole("button", { name: "Pick it back up" }).click();
      const field = page.locator(`#${state.questionId}-input`);
      await field.waitFor({ timeout: WAIT_MS });
      assert.equal(
        await field.inputValue(),
        answer,
        "re-applying lost the answers the withdraw copy promises are kept",
      );
      await waitForRecaptchaWidget(page, { timeout: WAIT_MS });
      await page.getByRole("button", { name: "Submit application" }).click();
      await page.getByRole("heading", { name: "Your application is in" }).waitFor({ timeout: WAIT_MS });
    });

    await step("the applicant status hub lists the round", async () => {
      // This step used to skip while /applications 404ed, because the status
      // hub had not been written. It has (PR14), the step ran for real on
      // 6 September 2026, and a 404 here is now a defect rather than a
      // not-yet: the page the applicant is told to come back to is gone.
      const res = await page.goto(`${origin}/applications`, { waitUntil: "domcontentloaded" });
      assert.ok(res && res.status() < 400, `GET /applications answered ${res?.status()}`);
      await page
        .getByText(`Funnel intake ${state.funnelRunId}`, { exact: false })
        .first()
        .waitFor({ timeout: WAIT_MS });
    });

    await step("taking a pre-course seat", async () => {
      await page.goto(courseUrl, { waitUntil: "domcontentloaded" });
      // The course page renders its call to action twice (hero and foot), but
      // only the hero mounts the session picker; the foot links up to it. So
      // there is exactly one control per session and no `.first()` scoping
      // here. If a second picker ever comes back, these locators fail on
      // strict mode rather than quietly driving whichever one loaded first.
      const slot = page.locator(
        `input[name="course-session"][value="${state.groupIds[0]}"]`,
      );
      await slot.waitFor({ timeout: WAIT_MS });
      // The foot placement links up to the hero picker instead of mounting a
      // second one. Exactly one anchor and exactly one link to it: a missing
      // anchor would leave a dead in-page link with every other step green.
      assert.equal(await page.locator("#pick-a-session").count(), 1, "the hero picker anchor is missing or duplicated");
      assert.equal(await page.locator('a[href="#pick-a-session"]').count(), 1, "the foot's Pick a session link is missing or duplicated");
      // The radio is clipped to 1px by design (the whole card is the label),
      // so the click goes where a person's would: on the card.
      await page.locator("label").filter({ has: slot }).click();
      await page.getByRole("button", { name: "Take this place" }).click();
      // The confirmation sentence, not the slot name on its own: the slot name
      // is also in the list this branch replaces, so matching it alone would
      // pass against the page that was already on screen.
      await page.getByText(/You'?re in Funnel session A/).waitFor({ timeout: WAIT_MS });
      await page.getByRole("button", { name: "Leave this course" }).waitFor({ timeout: WAIT_MS });
    });

    await step("leaving the course needs the typed course title", async () => {
      await page.getByRole("button", { name: "Leave this course" }).click();
      const confirm = page.locator("#dropout-confirm");
      await confirm.waitFor({ timeout: WAIT_MS });
      const leave = page.getByRole("button", { name: "Leave the course" });
      assert.equal(
        await leave.isDisabled(),
        true,
        "the leave button was live before the course title was typed",
      );
      await confirm.fill(state.courseTitle);
      await leave.click();
      // Dropping out is irreversible FROM HERE by decision, so the picker the
      // member used does NOT come back offering a place: it says the seat has
      // gone back to the group, and the way out is gone with it.
      await page.getByText(/You'?re off the course/).waitFor({ timeout: WAIT_MS });
      assert.equal(
        await page.getByRole("button", { name: "Leave this course" }).count(),
        0,
        "the drop-out card was still offered after the member had left",
      );
      // WHOLE PAGE, not the hero picker's subtree. This assertion used to pin
      // a defect: the page mounted a CourseCTA at the hero and another at the
      // foot, each with its own GroupPicker and its own state, so the foot one
      // never heard about the drop-out and went on offering "Take this place"
      // under a hero saying signing up again is not possible here. The fix
      // mounts one picker, in the hero, and gives the foot a link up to it, so
      // the count that used to be 1 is the count that must now be 0. Reading
      // the whole page is what makes that fix stick.
      assert.equal(
        await page.getByRole("button", { name: "Take this place" }).count(),
        0,
        "somewhere on the page still offered a place after the member had left. " +
          "The course page must mount exactly one session picker (the hero's): a " +
          "second one keeps its own state and contradicts the first.",
      );
    });
  } finally {
    await context.close();
    await browser.close();
    recorder.writeMarker();
  }
});
