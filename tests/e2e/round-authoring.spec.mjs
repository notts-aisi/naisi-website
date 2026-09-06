/**
 * Round authoring, end to end, in a real browser.
 *
 * Sign in as the admin -> the admissions console -> New round -> the editor,
 * with six things still to do -> standfirst -> deadline and decision date ->
 * a required long-text question -> an outcome run -> a reviewer and a final
 * decider -> the panel goes green -> open it -> the public apply page shows
 * it and gates a signed-out visitor -> close it -> the public form shuts ->
 * take the reviewer and the decider back off.
 *
 * ## How to run it
 *
 *   npm run e2e:browser -- --spec round-authoring            # deployed dev
 *   npm run e2e:browser -- --local --spec round-authoring    # its own server
 *
 * `scripts/run-e2e.mjs` seeds the throwaway world (one course, one run: see
 * `scripts/e2e-fixtures/round-authoring.mjs` for why that is all), leaves its
 * ids in a state file under `.e2e-state/`, and tears everything down
 * afterwards. Running this file on its own is supported but only once a seed
 * exists: it reads the state file and skips loudly when there is none.
 *
 * ## It signs in as the OWNER's admin, and appoints nobody new
 *
 * The harness may not create an account above role `pending`, so the admin is
 * the owner's own, read from `.env.e2e.secrets.local` and never printed. The
 * one place that matters beyond the sign-in is the reviewer picker: appointing
 * somebody writes `users.admissionsReviewer` on a REAL account, so this spec
 * appoints an ADMIN (who already holds every power the appointment grants) and
 * refuses to appoint an SU-recognised committee member, and its last step
 * takes the appointment back off through the same picker, which is what makes
 * the route clear the flag again. The fixture module says the rest.
 *
 * ## CHROMIUM ONLY, and that is a limitation rather than a choice
 *
 * Playwright drives Chromium here and nothing else. This codebase has already
 * shipped a Safari-only defect (a `<button>` whose inline background WebKit
 * painted its own grey face over), and the console is nothing but buttons. So
 * a green run here is a REGRESSION NET and never a substitute for the manual
 * Safari pass before dev goes to main.
 *
 * ## It is one test with ordered steps, not eleven tests
 *
 * Authoring a round is a sequence: there is no "open it" to check without the
 * six readiness items before it, and no public page to read without the open.
 * Independent tests would each have to rebuild the round through the same
 * eleven presses, which is both slower and a different thing to assert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertTarget,
  hasAdminCredentials,
  loadSecrets,
} from "../../scripts/e2e/lib/env.mjs";
import {
  createStepRecorder,
  newIdentityPage,
  openBrowser,
  signInWithPassword,
  stubRecaptchaOnLoopback,
} from "../../scripts/e2e/lib/browser.mjs";
import {
  ARTIFACTS_DIR,
  RECAPTCHA_SKIP_REASON,
  markerPath,
  statePath,
  stateDir,
} from "../../scripts/e2e-fixtures/core.mjs";
import {
  READINESS_LABELS,
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
} from "../../scripts/e2e-fixtures/round-authoring.mjs";

/**
 * Where this run's ledger and marker live. The runner hands every child an
 * `E2E_STATE_DIR`, and `stateDir()` is the one place that reads it; a
 * hand-driven `node --test` on this file alone falls back to the directory the
 * fixture writes to by default.
 */
const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/**
 * Every locator waits at most this long, and it is longer than the funnel's
 * thirty seconds on purpose. Against a deployed target dev is a cold Cloud
 * Run; against the shared harness server it is a Next DEV server, which
 * compiles a route the first time anybody asks for it, and `/admin/admissions`
 * plus its editor are two of the heaviest client pages in the app.
 */
const WAIT_MS = 45_000;

/**
 * Why a step may not run in this mode, or null.
 *
 * Kept in the shape every spec uses even though `RECAPTCHA_DEPENDENT_STEPS` is
 * empty here: nothing on this journey sends a reCAPTCHA token (the gate is on
 * `/api/register` and the three apply routes), so a deployed run drives all
 * eleven steps and a skip would be a shortfall rather than an accepted gap.
 * The wiring stays so that a step which later grows a gated control is one
 * list entry away from being reported honestly.
 */
let skipReasonFor = () => null;

/**
 * The one reason this file may record for a step it did not run, shared with
 * the runner through `core.mjs`. The runner accepts a skip only when the step
 * is reCAPTCHA-dependent AND the marker carries this exact reason.
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
    ? `No round-authoring fixture at ${STATE_PATH}. Run: npm run e2e:browser -- --spec round-authoring.`
    : !hasAdminCredentials()
      ? "This spec signs in as the owner's admin. Put E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD in .env.e2e.secrets.local at the repo root, or export them."
      : null;

/**
 * The origin under test, through the auth harness's own allowlist so a typo
 * cannot aim a run that CREATES AND OPENS AN ADMISSION ROUND at production.
 */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

/** Next month's fifteenth, which is always ahead of now and always in-month. */
function targetMonthLabels(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 15);
  return {
    day: "15",
    // "YYYY-MM-DD" for the decisions-by field, which is a civil date key.
    decisionsBy: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-15`,
  };
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP`.
test(
  "round authoring: create a round, fill the readiness bar, open it, close it",
  { skip: skipReason ?? false },
  async (t) => {
    const origin = baseUrl();
    const admin = loadSecrets();
    const dates = targetMonthLabels();

    const { browser, context, page } = await openBrowser();
    // A Next dev server compiles each route on its first request, and the
    // admissions editor is a big client page. The default 30s navigation
    // timeout is the one wait the locator timeout above cannot cover.
    page.setDefaultNavigationTimeout(WAIT_MS);
    const recorder = createStepRecorder({
      t,
      page,
      markerPath: MARKER,
      artifactsDir: ARTIFACTS_DIR,
      skipReasonFor: (name) => skipReasonFor(name),
    });
    const step = (name, fn) => recorder.step(name, fn);
    // Nothing here is reCAPTCHA-gated, so the stub changes nothing on this
    // journey. It is still armed on loopback so that the mode this run is in
    // is decided in exactly one place, the same way every other spec does it.
    const recaptchaStubbed = await stubRecaptchaOnLoopback(page, origin);
    if (!recaptchaStubbed && RECAPTCHA_DEPENDENT_STEPS.length > 0) {
      skipReasonFor = (name) =>
        RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
    }

    /** One readiness line, found by the wording the panel shows. */
    const check = (label) => page.getByTestId("readiness-item").filter({ hasText: label });

    /**
     * Whether the panel calls one check done.
     *
     * Read off `textContent` rather than a class or an icon, because the tick
     * is `✓` in an `aria-hidden` span and the WORDS are in a visually-hidden
     * one: "(done)" and "(still to do)" are what a screen reader user is told,
     * which makes them the honest thing to assert and the thing that must not
     * quietly stop being rendered.
     */
    async function readCheck(label) {
      const item = check(label);
      await item.waitFor({ timeout: WAIT_MS });
      return (await item.textContent()) ?? "";
    }

    async function assertCheck(label, done) {
      const text = await readCheck(label);
      assert.ok(
        text.includes(done ? "(done)" : "(still to do)"),
        `the readiness panel reads ${JSON.stringify(text.replace(/\s+/g, " ").trim())}, ` +
          `but this run expected "${label}" to be ${done ? "done" : "still to do"}.`,
      );
    }

    /** Press one section's Save and wait for the card to say it saved. */
    async function saveSection(sectionId) {
      const section = page.locator(`#${sectionId}`);
      await section.getByTestId("section-save").click();
      await section.getByTestId("section-saved").waitFor({ timeout: WAIT_MS });
    }

    /** The editor url, learned from the browser: only it knows the round id. */
    let editorUrl = "";
    let roundId = "";
    /** Who the admin appointed, as the picker spells their name. */
    let appointee = "";
    /** The second browser identity: a signed-out visitor on the public page. */
    let guest = null;

    try {
      await step("the admin signs in and the admissions console lists its rounds", async () => {
        // Sign-in is `signInWithPassword` in scripts/e2e/lib/browser.mjs, which
        // waits for the form to hydrate and the card to land before it types.
        await signInWithPassword(
          page,
          origin,
          { email: admin.adminEmail, password: admin.adminPassword },
          { timeout: WAIT_MS },
        );
        await page.goto(`${origin}/admin/admissions`, { waitUntil: "domcontentloaded" });
        // The New round card is what says this caller may author. A reviewer
        // reaches the same page and sees only the list, so waiting on this
        // control is also the assertion that the sign-in landed as an admin.
        await page.getByTestId("rounds-new-label").waitFor({ timeout: WAIT_MS });
        await page.getByTestId("rounds-new-create").waitFor({ timeout: WAIT_MS });
      });

      await step("a new round opens its own editor with six things still to do", async () => {
        await page.getByTestId("rounds-new-label").fill(state.roundLabel);
        await page.getByTestId("rounds-new-create").click();
        // The list is reloaded by the create, so the new round appearing on it
        // is the page agreeing the write landed. Then the row is the way in,
        // the same as any other round.
        const row = page.getByTestId("rounds-row").filter({ hasText: state.roundLabel });
        await row.waitFor({ timeout: WAIT_MS });
        await row.click();
        await page.waitForURL(/\/admin\/admissions\/[^/]+$/, { timeout: WAIT_MS });
        editorUrl = page.url();
        roundId = decodeURIComponent(editorUrl.split("/").pop());
        assert.ok(roundId.includes("round-authoring"), `the round id is ${roundId}`);

        await page.getByTestId("readiness-panel").waitFor({ timeout: WAIT_MS });
        assert.match(
          (await page.getByTestId("readiness-verdict").textContent()) ?? "",
          /6 things still to do/,
          "a brand-new enrolment round is held to six checks and should meet none of them",
        );
        for (const label of Object.values(READINESS_LABELS)) {
          await assertCheck(label, false);
        }
        // The manual reminder lane is shut while the round is a draft: a draft
        // round has no applicants, so there is nobody to nudge and the route
        // would refuse anyway. Read, never pressed: pressing it writes the
        // scheduler's bookkeeping to a live shared config document.
        assert.equal(
          await page.getByTestId("round-send-reminders").isDisabled(),
          true,
          "the send-reminders-now button was live on a draft round",
        );
      });

      await step("the standfirst saves on the details section", async () => {
        await page.locator("#round-blurb").fill(state.blurb);
        await saveSection("details");
        // The heading, not the input: it renders the round the PATCH answered
        // with, so this reads what the SERVER now stores rather than what is
        // still sitting in the box. The name matters beyond tidiness, because
        // it is the only key teardown has: the round's id is `slugId(label)`,
        // so a save that silently rewrote the name would strand a live round
        // on the dev project under a manifest that read zero.
        await page
          .getByRole("heading", { name: state.roundLabel, exact: true })
          .waitFor({ timeout: WAIT_MS });
      });

      await step("setting the deadline and the decision date ticks off both window checks", async () => {
        // The deadline is a hand-built popover, not a native date input: press
        // the trigger, step forward a month so the day is certainly ahead of
        // now, pick the fifteenth, and press Done. A fresh pick defaults to
        // 18:00, which is what the trigger then reads back.
        //
        // Reached through the Field's own label rather than by position: the
        // Opens picker beside it is the same component with the same "Not set"
        // trigger, and `Field` renders `<label for="round-closes">` as the
        // first child with the control as its next sibling, so this is keyed
        // on a product id rather than on which of the two comes first.
        const closes = page.locator('label[for="round-closes"] ~ div');
        await closes.getByRole("button", { name: "Not set" }).click();
        const picker = closes.getByRole("dialog", { name: "Pick date and time" });
        await picker.waitFor({ timeout: WAIT_MS });
        await picker.getByRole("button", { name: "Next month" }).click();
        await picker.getByRole("button", { name: dates.day, exact: true }).click();
        await picker.getByRole("button", { name: "Done" }).click();
        await picker.waitFor({ state: "detached", timeout: WAIT_MS });

        await page.locator("#round-decisions").fill(dates.decisionsBy);
        await saveSection("window");

        await assertCheck(READINESS_LABELS.closesAt, true);
        await assertCheck(READINESS_LABELS.decisionsBy, true);
        // The other four have not been touched, and a panel that ticked one of
        // them off the back of a window save would be inventing readiness.
        await assertCheck(READINESS_LABELS.stageQuestions, false);
        await assertCheck(READINESS_LABELS.outcomeRuns, false);
      });

      await step("a required long-text question ticks off the first stage", async () => {
        // The round arrived with one stage: the create route writes it in the
        // same batch, because "add a stage before you add a question" means
        // nothing to anybody. The question goes on THAT stage rather than on a
        // second one, and that is load-bearing: readiness asks about the FIRST
        // stage in asked order, so a question added to a stage 2 would leave
        // the panel red with a form that looks full.
        const stages = page.locator("#stages");
        await stages.getByRole("button", { name: "+ Add question" }).click();
        await stages.getByRole("button", { name: /^Long text/ }).click();
        await stages
          .getByLabel("Question", { exact: true })
          .fill("Why do you want to take part?");
        await stages.getByLabel("Required", { exact: true }).check();
        await stages.getByTestId("stage-save").click();
        await stages.getByText("Saved.", { exact: true }).waitFor({ timeout: WAIT_MS });

        await assertCheck(READINESS_LABELS.stageQuestions, true);
      });

      await step("naming an outcome run gives the round somewhere to place people", async () => {
        // The outcome picker lists every run on the site, so the seeded one is
        // found by its label rather than by position. Scoped through the
        // Field's own label, because the evidence picker directly below lists
        // the same runs and an unscoped match would find both.
        const runs = page.locator('label[for="outcome-runs"] ~ div');
        const runRow = runs.locator("label").filter({ hasText: state.runLabel });
        await runRow.waitFor({ timeout: WAIT_MS });
        await runRow.locator('input[type="checkbox"]').check();
        await saveSection("outcomes");

        await assertCheck(READINESS_LABELS.outcomeRuns, true);
      });

      await step("appointing a reviewer and a final decider turns the panel green", async () => {
        const roles = page.locator("#roles");
        // Each row of the picker is a label wrapping a checkbox, the person's
        // name, and their role. That shape is also the selector: the only
        // other labels in this section are the Field ones, which wrap no
        // checkbox. The list arrives from a Firestore read, so the first row
        // appearing is the page agreeing it loaded.
        const rows = roles.locator('label:has(input[type="checkbox"])');
        await rows.first().waitFor({ timeout: WAIT_MS });

        // ONLY AN ADMIN. The picker offers admins and SU-recognised committee,
        // and appointing either would write `users.admissionsReviewer` on a
        // real account. An admin already holds every power the appointment
        // grants (they can read applications regardless), so appointing one
        // grants nothing new; appointing a committee member would hand out a
        // real capability that no test has any business handing out.
        const count = await rows.count();
        let index = -1;
        for (let i = 0; i < count; i += 1) {
          const role = ((await rows.nth(i).locator("span").nth(1).textContent()) ?? "").trim();
          if (role !== "admin") continue;
          index = i;
          appointee = ((await rows.nth(i).locator("span").nth(0).textContent()) ?? "").trim();
          break;
        }
        assert.ok(
          index >= 0,
          `the reviewer picker offered ${count} eligible people and none of them is an ` +
            "admin. This spec will not appoint an SU-recognised committee member, because " +
            "that would grant a real person access to applications they did not have.",
        );

        await rows.nth(index).locator('input[type="checkbox"]').check();
        await page.locator("#final-decider").selectOption({ label: appointee });
        await saveSection("roles");

        await assertCheck(READINESS_LABELS.reviewers, true);
        await assertCheck(READINESS_LABELS.finalDecider, true);
        assert.match(
          (await page.getByTestId("readiness-verdict").textContent()) ?? "",
          /Everything this round needs is in place/,
          "six checks are met but the panel has not called the round ready",
        );
      });

      await step("opening the round shows it open in the editor and on the list", async () => {
        await page
          .getByTestId("round-status-controls")
          .getByRole("button", { name: "Open for applications" })
          .click();
        // The status control reloads the round when the move lands, so the
        // badge in the header changing is the server's answer rather than an
        // optimistic paint.
        await page
          .getByTestId("round-status-badge")
          .filter({ hasText: "Open for applications" })
          .waitFor({ timeout: WAIT_MS });
        // And the manual reminder lane opens with it. Still only read.
        assert.equal(
          await page.getByTestId("round-send-reminders").isDisabled(),
          false,
          "the send-reminders-now button stayed shut on an open round",
        );

        await page.goto(`${origin}/admin/admissions`, { waitUntil: "domcontentloaded" });
        const row = page.getByTestId("rounds-row").filter({ hasText: state.roundLabel });
        await row.waitFor({ timeout: WAIT_MS });
        assert.match(
          (await row.textContent()) ?? "",
          /Open for applications/,
          "the console list still shows the round as a draft",
        );
      });

      await step("the public apply page shows the round and gates a signed-out visitor", async () => {
        // A second browser CONTEXT, so this visitor has none of the admin's
        // cookies or Firebase Auth client state. Signing the admin out and
        // back in would prove something weaker: the interesting assertion is
        // that a stranger sees the round the admin just opened.
        guest = await newIdentityPage(browser);
        guest.page.setDefaultNavigationTimeout(WAIT_MS);
        const applyUrl = `${origin}/apply/${encodeURIComponent(roundId)}`;
        const res = await guest.page.goto(applyUrl, { waitUntil: "domcontentloaded" });
        assert.ok(res && res.status() < 400, `GET /apply/${roundId} answered ${res?.status()}`);

        await guest.page
          .getByRole("heading", { name: state.roundLabel })
          .waitFor({ timeout: WAIT_MS });
        // The standfirst the admin typed in the details section, on the page an
        // applicant reads. The two are three route calls apart, so this is the
        // authoring console and the public page agreeing about one string.
        await guest.page
          .getByText(state.blurb, { exact: false })
          .first()
          .waitFor({ timeout: WAIT_MS });
        await guest.page
          .getByRole("heading", { name: "Sign in to apply" })
          .waitFor({ timeout: WAIT_MS });
        // The gate must not render the form behind it. A start button here
        // would mean the page had decided a signed-out visitor could write.
        assert.equal(
          await guest.page.getByRole("button", { name: "Start your application" }).count(),
          0,
          "the signed-out gate rendered the application form",
        );
      });

      await step("closing the round closes the public form", async () => {
        await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
        await page
          .getByTestId("round-status-controls")
          .getByRole("button", { name: "Closed", exact: true })
          .click();
        await page
          .getByTestId("round-status-badge")
          .filter({ hasText: "Closed" })
          .waitFor({ timeout: WAIT_MS });

        await guest.page.reload({ waitUntil: "domcontentloaded" });
        // The round is still a public object (only a draft or an archived one
        // 404s), but the invitation is gone: the gate now offers to show you
        // what you sent rather than a form to fill in.
        await guest.page
          .getByRole("heading", { name: "Sign in to check your application" })
          .waitFor({ timeout: WAIT_MS });
        await guest.page
          .getByText("Applications have closed.", { exact: false })
          .first()
          .waitFor({ timeout: WAIT_MS });
      });

      await step("taking the reviewer and the decider off again leaves the round unstaffed", async () => {
        // This is the step that puts the one write outside this fixture's
        // fence back: appointing somebody stamps `users.admissionsReviewer` on
        // their account, and the roles route clears it again for anybody it
        // removes who is not still named on another round. Teardown deletes
        // the round and cannot reach that field, so the un-appointment has to
        // happen here, through the same picker, and be asserted.
        // The chip is the only button in the section carrying the
        // appointee's name, and pressing it is how a person takes them off.
        const chip = page.locator("#roles").locator("button").filter({ hasText: appointee }).first();
        await chip.waitFor({ timeout: WAIT_MS });
        await chip.click();
        await page.locator("#final-decider").selectOption("");
        await saveSection("roles");

        await assertCheck(READINESS_LABELS.reviewers, false);
        await assertCheck(READINESS_LABELS.finalDecider, false);
        assert.match(
          (await page.getByTestId("readiness-verdict").textContent()) ?? "",
          /2 things still to do/,
          "the round still reads as staffed after both appointments were taken off",
        );
      });
    } finally {
      if (guest) await guest.context.close();
      await context.close();
      await browser.close();
      recorder.writeMarker();
    }
  },
);
