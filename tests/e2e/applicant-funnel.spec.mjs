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
 * `scripts/run-applicant-funnel.mjs` seeds the throwaway world, hands this
 * file its ids through E2E_FUNNEL_STATE, and tears everything down afterwards.
 * Running this file on its own is supported (`node --test
 * tests/e2e/applicant-funnel.spec.mjs`) but only once a seed exists: it reads
 * the state file and skips loudly when there is none.
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
 * each step records its name as it finishes and the list is written to
 * `MARKER_PATH` in the `finally`; `scripts/run-applicant-funnel.mjs` deletes
 * that file before the run and refuses to report success unless it comes back
 * naming every step in `FUNNEL_STEPS` (the list lives in the fixture module,
 * and a guard test pins it against the step names below). A run that opened no
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
import { readFileSync, writeFileSync } from "node:fs";
import { assertTarget } from "../../scripts/e2e/lib/env.mjs";
import {
  MARKER_PATH,
  STATE_PATH as DEFAULT_STATE_PATH,
  WITHDRAW_WORD,
} from "../../scripts/seed-fake-applicants.mjs";

const STATE_PATH = process.env.E2E_FUNNEL_STATE ?? DEFAULT_STATE_PATH;
const MARKER = process.env.E2E_FUNNEL_MARKER ?? MARKER_PATH;

/** Every locator waits at most this long. Generous: dev is a cold Cloud Run. */
const WAIT_MS = 30_000;

/**
 * The steps this file actually completed, written out at the end whether the
 * run passed or failed.
 *
 * A skipped spec and a passing spec are the same exit code, so the runner
 * cannot tell them apart from `node --test` alone: it reads this instead, and
 * refuses to call a run green unless every step in `FUNNEL_STEPS` is named
 * here. Written in the `finally` rather than after the last step so a failed
 * run still says which step it got to.
 */
const completed = [];

function writeMarker() {
  try {
    writeFileSync(
      MARKER,
      `${JSON.stringify({ finishedAt: new Date().toISOString(), steps: completed }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    console.error(`[funnel-spec] could not write the completion marker: ${err.message}`);
  }
}

/** Runs one named step and records it only if it finished without throwing. */
async function step(t, name, fn) {
  let ok = false;
  await t.test(name, async (st) => {
    await fn(st);
    ok = true;
  });
  if (ok) completed.push(name);
}

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

/** Sign in through the real form and wait for the app to take the browser off /login. */
async function signIn(page, origin, applicant) {
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#auth-email").waitFor({ timeout: WAIT_MS });
  await page.locator("#auth-email").fill(applicant.email);
  await page.locator("#auth-password").fill(applicant.password);
  await page.locator('button[type="submit"][form="auth-form"]').click();
  // A seeded applicant is role `pending`, so the post-auth destination is
  // /pending-approval rather than the `next` parameter. Waiting on "the URL
  // stopped being /login" asserts the handoff without hard-coding which
  // landing page a role gets, which is a decision this spec has no stake in.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: WAIT_MS });
}

test("applicant funnel: apply, withdraw, re-apply, enrol, drop out", { skip: skipReason }, async (t) => {
  const origin = baseUrl();
  const applicant = state.applicants[0];
  const applyUrl = `${origin}/apply/${encodeURIComponent(state.roundId)}`;
  const courseUrl = `${origin}/courses/${encodeURIComponent(state.courseId)}`;

  const browser = await playwright.chromium.launch();
  // A desktop viewport on purpose: the availability grid renders one day at a
  // time below 48rem and all seven columns above it, and the painting step
  // below drags down a column that only exists in the wide layout.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await step(t, "the public course page shows the seeded session slots", async () => {
      await page.goto(courseUrl, { waitUntil: "domcontentloaded" });
      await page.getByText(state.courseTitle, { exact: false }).first().waitFor({ timeout: WAIT_MS });
      for (const name of ["Funnel session A", "Funnel session B"]) {
        await page.getByText(name, { exact: false }).first().waitFor({ timeout: WAIT_MS });
      }
    });

    await step(t, "a signed-out visitor gets the sign-in gate on the apply page", async () => {
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

    await step(t, "applicant 1 signs in", async () => {
      await signIn(page, origin, applicant);
    });

    await step(t, "starting an application opens an editable draft", async () => {
      await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Start your application" }).click();
      await page.locator(`#${state.questionId}-input`).waitFor({ timeout: WAIT_MS });
    });

    const answer = `Funnel run ${state.funnelRunId}: this answer is written by an automated run.`;

    await step(t, "the draft saves", async () => {
      await page.locator(`#${state.questionId}-input`).fill(answer);
      await page.getByRole("button", { name: "Save draft" }).click();
      // The bar's status line is what tells an applicant their work is on the
      // server. Asserting on it rather than on a network response is the point:
      // a save that succeeded silently and left the bar saying "unsaved" is
      // still a bug for the person in the queue at the fair.
      await page.getByText(/Saved at /).waitFor({ timeout: WAIT_MS });
    });

    await step(t, "the draft survives a reload", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      const field = page.locator(`#${state.questionId}-input`);
      await field.waitFor({ timeout: WAIT_MS });
      assert.equal(
        await field.inputValue(),
        answer,
        "the saved answer did not come back after a reload",
      );
    });

    await step(t, "the availability grid paints and the marks persist", async () => {
      // Monday (weekday 1), the first eight quarter hours: 09:00 to 11:00.
      const from = page.locator('[data-day="1"][data-slot="0"]');
      const to = page.locator('[data-day="1"][data-slot="7"]');
      await from.waitFor({ timeout: WAIT_MS });
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      assert.ok(a && b, "the availability grid did not lay out");
      // A real pointer drag rather than eight clicks: the drag is the gesture
      // the component is built around (pointer capture, run filling), and
      // clicking each cell would leave that path untested.
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
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

    await step(t, "submitting moves the application to view-only", async () => {
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

    await step(t, "withdrawing needs the typed word and then takes it back", async () => {
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

    await step(t, "picking it back up restores the answers and submits again", async () => {
      await page.getByRole("button", { name: "Pick it back up" }).click();
      const field = page.locator(`#${state.questionId}-input`);
      await field.waitFor({ timeout: WAIT_MS });
      assert.equal(
        await field.inputValue(),
        answer,
        "re-applying lost the answers the withdraw copy promises are kept",
      );
      await page.getByRole("button", { name: "Submit application" }).click();
      await page.getByRole("heading", { name: "Your application is in" }).waitFor({ timeout: WAIT_MS });
    });

    await step(t, "the applicant status hub lists the round", async (st) => {
      // PR14 owns /applications. Until it lands the route 404s, and a funnel
      // that went red over a page nobody has written yet would be noise: the
      // assertion is armed by the route existing, and says so either way.
      const res = await page.goto(`${origin}/applications`, { waitUntil: "domcontentloaded" });
      if (res && res.status() === 404) {
        st.skip(
          "GET /applications returned 404: the status hub (PR14) is not on this build. " +
            "This assertion arms itself the moment that route exists.",
        );
        return;
      }
      await page.getByText(state.roundId, { exact: false }).or(
        page.getByText(`Funnel intake ${state.funnelRunId}`, { exact: false }),
      ).first().waitFor({ timeout: WAIT_MS });
    });

    await step(t, "taking a pre-course seat", async () => {
      await page.goto(courseUrl, { waitUntil: "domcontentloaded" });
      const slot = page.locator(`input[name="course-session"][value="${state.groupIds[0]}"]`);
      await slot.waitFor({ timeout: WAIT_MS });
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

    await step(t, "leaving the course needs the typed course title", async () => {
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
      // Dropping out is irreversible FROM HERE by decision, so the picker does
      // NOT come back offering a place: it says the seat has gone back to the
      // group. Asserting the honest end state rather than the one a reader
      // might assume is the point of this line.
      await page.getByText(/You'?re off the course/).waitFor({ timeout: WAIT_MS });
      assert.equal(
        await page.getByRole("button", { name: "Take this place" }).count(),
        0,
        "the picker offered a place again after an irreversible drop-out",
      );
    });
  } finally {
    await context.close();
    await browser.close();
    writeMarker();
  }
});
