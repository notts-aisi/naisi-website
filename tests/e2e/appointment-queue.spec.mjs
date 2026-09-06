/**
 * The appointment queue, end to end, in a real browser.
 *
 * Sign in as the owner's admin -> the round's appointment queue -> read both
 * applicants, their answers and when each can be in a room -> appoint the
 * first onto a run, through the confirm step -> decline the second, through
 * its own -> read both decisions, the facilitator and the audit line back out
 * of Firestore -> read the two emails out of the send log.
 *
 * ## How to run it
 *
 *   E2E_TARGET=http://127.0.0.1:3100 node scripts/run-e2e.mjs --spec appointment-queue
 *   node scripts/run-e2e.mjs --local --spec appointment-queue
 *
 * `scripts/run-e2e.mjs` seeds the round, the run and the two submitted
 * applications, leaves their ids in a state file under `.e2e-state/`, and tears
 * everything down afterwards. Running this file on its own is supported once a
 * seed exists; it reads the state file and skips loudly when there is none.
 *
 * ## Neither button decides on one press, and this spec presses both halves
 *
 * An appointment writes a uid onto a run and mails the person; a decline mails
 * them too; and the route refuses to overwrite either afterwards, because the
 * email has already gone. So each press opens a confirm step that names the
 * person and the run, and this spec goes through it rather than around it: the
 * confirm step is the safety, and a spec that reached past it would be proving
 * a journey nobody takes.
 *
 * ## The applications are seeded, not applied for
 *
 * The apply routes are reCAPTCHA-gated and are the applicant funnel's job. This
 * spec is about the decider's screen, so the fixture writes the two submitted
 * applications in the shape those routes leave behind, and everything from the
 * queue onwards is driven for real. That is what lets this run against a
 * deployed target as well as a local one.
 *
 * ## CHROMIUM ONLY, which is a limitation rather than a choice
 *
 * Playwright drives Chromium here and nothing else, so a green run is a
 * REGRESSION NET and never a substitute for the manual Safari pass before dev
 * goes to main.
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
  applicationDocId,
} from "../../scripts/e2e-fixtures/appointment-queue.mjs";

const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: dev is a cold Cloud Run. */
const WAIT_MS = 30_000;

/**
 * The first request to an admissions route on a DEV server compiles the whole
 * tree before it answers, which is slower than anything a deployed build does.
 * Only the first navigation gets this; everything after it is a warm route.
 */
const FIRST_LOAD_MS = 90_000;

/**
 * Why a step may not run in this mode, or null.
 *
 * This spec has no reCAPTCHA-gated step: the queue is an admin page behind a
 * session cookie and the decide route is a plain POST, so
 * `SPEC.recaptchaDependentSteps` is empty and nothing is ever skipped. The
 * wiring is here in the shape the applicant funnel uses, so a step that does
 * become gated is skipped with the one reason the runner accepts rather than
 * with wording of its own.
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
 * of every production deploy. So it is resolved at runtime and a missing one is
 * a SKIP with the install line, not a red suite.
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
    ? `No appointment-queue fixture at ${STATE_PATH}. Run: node scripts/run-e2e.mjs --spec appointment-queue.`
    : !secrets.adminEmail || !secrets.adminPassword
      ? "E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are not set. Only a round's final decider or an admin may decide, and the harness may never create either: put the owner's own credentials in .env.e2e.secrets.local."
      : null;

/** The origin under test, through the harness's own allowlist so a typo cannot
 *  aim a run that APPOINTS PEOPLE AND MAILS THEM at production. */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

/**
 * The rows the send log holds for one address, once there are `expected` of
 * them or the deadline passes.
 *
 * Both decision emails are fire and forget: the route answers the browser and
 * the send (and its `emailSends` row) lands a moment later. Polling rather
 * than sleeping a fixed time, so the usual case costs a second and the slow
 * case still passes.
 */
async function sendRowsFor(email, expected) {
  const deadline = Date.now() + WAIT_MS;
  let rows = [];
  for (;;) {
    const snap = await fixtureQuery("emailSends").where("to", "==", email).get();
    rows = snap.docs.map((doc) => doc.data() ?? {});
    if (rows.length >= expected || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP`.
test(
  "appointment queue: appoint one facilitator applicant and decline another",
  { skip: skipReason ?? false },
  async (t) => {
    const origin = baseUrl();
    const queueUrl = `${origin}/admin/admissions/${encodeURIComponent(state.roundId)}/appointments`;
    const [appointee, declined] = state.applicants;
    /** What the queue calls the run, in the decided sentence and the confirm. */
    const runName = `${state.courseTitle} ${state.runLabel}`;

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

    /** One applicant's card, found by the name the queue renders. The two
     *  fixture names differ in a whole word, so neither can match the other. */
    const cardFor = (applicant) =>
      page
        .getByTestId("appointment-card")
        .filter({ hasText: applicant.displayName })
        .first();

    try {
      await step("the admin signs in and opens the appointment queue", async () => {
        // Sign-in is `signInWithPassword` in scripts/e2e/lib/browser.mjs, which
        // waits for the form to hydrate and the card to land before it types.
        await signInWithPassword(
          page,
          origin,
          { email: secrets.adminEmail, password: secrets.adminPassword },
          { timeout: FIRST_LOAD_MS },
        );
        await page.goto(queueUrl, { waitUntil: "domcontentloaded", timeout: FIRST_LOAD_MS });
        await page
          .getByRole("heading", { name: "Appointments", level: 1 })
          .waitFor({ timeout: FIRST_LOAD_MS });
        // The queue is not name-blind, and says so on the page rather than
        // leaving somebody who came from the reviewing side to wonder whether
        // the blinding is broken.
        await waitForWithReason(
          page.getByText("not name-blind", { exact: false }).first(),
          "the queue did not carry its own explanation of why the names are visible",
        );
      });

      await step(
        "the queue lists both applicants, their answers and when they can be in a room",
        async () => {
          assert.match(
            await page.locator("body").innerText(),
            /2 applications · 2 still to decide/,
            "the queue header did not count the two seeded applications",
          );
          for (const applicant of state.applicants) {
            const card = cardFor(applicant);
            await waitForWithReason(
              card,
              `no card for ${applicant.displayName}: a submitted application on this round is missing from the queue`,
            );
            const text = await card.innerText();
            assert.match(
              text,
              /To decide/,
              `${applicant.displayName} is not waiting for a decision`,
            );
            assert.ok(
              text.includes(`${applicant.displayName} wrote this answer`),
              `${applicant.displayName}'s answer is not on their card`,
            );
            assert.ok(
              text.includes(applicant.email),
              `${applicant.displayName}'s card does not carry the address the team would write to`,
            );
            // The drawn availability, rendered as a span rather than as a grid.
            // Half-open and named by its real end time: four marked quarter
            // hours from 17:00 read "17:00-18:00", not "17:00-17:45". This is
            // the assertion that pins the fixture's hand-written mask against
            // the encoder in src/lib/admissions/availability.ts.
            assert.ok(
              text.includes("17:00-18:00"),
              `${applicant.displayName}'s availability did not decode to the evening they drew`,
            );
          }
          assert.match(
            await cardFor(appointee).innerText(),
            /Tuesday/,
            "the first applicant's availability is not on the day the fixture drew",
          );
          assert.match(
            await cardFor(declined).innerText(),
            /Thursday/,
            "the second applicant's availability is not on the day the fixture drew",
          );
        },
      );

      await step("appointing the first applicant asks for the run and a confirmation", async () => {
        const card = cardFor(appointee);
        // THE PICKER OPENS ON NOTHING, and this is the assertion that keeps it
        // that way. It used to open on the first appointable run in the whole
        // project, which on a shared project is another fixture's run and in
        // production is whichever sorts first, so a decider who never looked at
        // the select could appoint somebody onto a run nobody chose and the
        // email would go out on the press.
        const runSelect = card.getByTestId("appointment-run-select");
        assert.equal(
          await runSelect.inputValue(),
          "",
          "the run picker pre-selected a run instead of waiting for the decider to choose",
        );
        assert.equal(
          await card.getByTestId("appointment-appoint").isDisabled(),
          true,
          "Appoint was live before a run had been chosen",
        );
        await runSelect.selectOption(state.runId);
        await card.getByTestId("appointment-appoint").click();
        await waitForWithReason(
          card.getByText("Appoint this person and email them now?", { exact: false }),
          "pressing Appoint decided immediately instead of asking to confirm",
        );
        const confirmText = await card.innerText();
        assert.ok(
          confirmText.includes(appointee.displayName),
          "the confirm step does not name the person it is about",
        );
        assert.ok(
          confirmText.includes(runName),
          "the confirm step does not name the run they would be joining",
        );
        await card.getByTestId("appointment-confirm").click();
      });

      await step("the appointed card names the run and says the email has gone", async () => {
        const card = cardFor(appointee);
        // The page re-runs the server component after a decide rather than
        // patching state, so this waits for the re-rendered card.
        await waitForWithReason(
          card.getByTestId("appointment-decided"),
          "the card never settled into a decided state after the appointment",
        );
        assert.equal(
          await card.getByTestId("appointment-decided").innerText(),
          `Appointed to ${runName}. The email has gone out.`,
          "the decided sentence does not name the run the person was appointed to",
        );
        assert.match(
          await card.innerText(),
          /Appointed/,
          "the card does not carry the Appointed chip",
        );
        assert.equal(
          await card.getByTestId("appointment-appoint").count(),
          0,
          "a decided card still offers to appoint, which the route would refuse",
        );
      });

      await step("declining the second applicant takes a confirmation too", async () => {
        const card = cardFor(declined);
        await card.getByTestId("appointment-decline").click();
        await waitForWithReason(
          card.getByText("Tell this person we cannot take them on?", { exact: false }),
          "pressing Decline decided immediately instead of asking to confirm",
        );
        // The note is not shared unless the decider ticks the switch, and the
        // confirm says which of the two it is about to do.
        assert.match(
          await card.innerText(),
          /Your note stays with us/,
          "the confirm step does not say whether the note is being sent",
        );
        await card.getByTestId("appointment-confirm").click();
        await waitForWithReason(
          card.getByTestId("appointment-decided"),
          "the card never settled into a decided state after the decline",
        );
        assert.equal(
          await card.getByTestId("appointment-decided").innerText(),
          "Declined. The email has gone out.",
          "the decided sentence is not the decline's",
        );
      });

      await step(
        "Firestore carries both decisions, the facilitator and the audit line",
        async () => {
          const appointedSnap = await fixtureDoc(
            "admissionApplications",
            applicationDocId(state.roundId, appointee.uid),
          ).get();
          const appointed = appointedSnap.data() ?? {};
          assert.equal(appointed.status, "appointed", "the appointed application's status did not move");
          assert.equal(
            appointed.outcome?.decision,
            "appoint",
            "the appointed application does not record the decision",
          );
          assert.equal(
            appointed.outcome?.targetRunId,
            state.runId,
            "the appointment does not name the run it was made onto",
          );

          const declinedSnap = await fixtureDoc(
            "admissionApplications",
            applicationDocId(state.roundId, declined.uid),
          ).get();
          const declinedRow = declinedSnap.data() ?? {};
          // A decline reuses `rejected`: it is the same ending as an enrolment
          // refusal, and the hub chooses its sentence from the round's kind.
          assert.equal(declinedRow.status, "rejected", "the declined application's status did not move");
          assert.equal(
            declinedRow.outcome?.decision,
            "decline",
            "the declined application does not record the decision",
          );
          assert.equal(
            declinedRow.outcome?.targetRunId,
            null,
            "a decline named a run, which it has no business doing",
          );

          // The appointment's real effect: the person is on the run's
          // facilitator list. Written by the route as the admin, which is the
          // only way this harness may cause a privilege to exist at all.
          const runSnap = await fixtureDoc("courseRuns", state.runId).get();
          const facilitators = runSnap.data()?.runFacilitatorUids ?? [];
          assert.ok(
            Array.isArray(facilitators) && facilitators.includes(appointee.uid),
            "the appointed applicant is not on the run's facilitator list",
          );
          assert.ok(
            !facilitators.includes(declined.uid),
            "the declined applicant was put on the run anyway",
          );

          // One audit line per appointment, written inside the same
          // transaction, so a decide that changed nothing leaves none.
          const audit = await fixtureQuery("courseAudit")
            .where("runId", "==", state.runId)
            .get();
          const rows = audit.docs.map((doc) => doc.data() ?? {});
          const appointments = rows.filter((row) => row.kind === "facilitator-appointed");
          assert.equal(
            appointments.length,
            1,
            `expected exactly one facilitator-appointed audit row, found ${appointments.length}`,
          );
          assert.equal(
            appointments[0].subjectUid,
            appointee.uid,
            "the audit line is about the wrong person",
          );
        },
      );

      await step("the two decision emails are logged", async () => {
        if (state.suppress) {
          // Suppressed: every fixture address was written to
          // `suppressedEmails` before anything was seeded, and
          // `sendAdmissionEmail` returns early on `isSuppressed()` before it
          // builds a message. A short settle first, so this cannot pass merely
          // by asking before a send that was going to happen anyway.
          await new Promise((resolve) => setTimeout(resolve, 5000));
          for (const applicant of state.applicants) {
            const rows = await sendRowsFor(applicant.email, 0);
            assert.equal(
              rows.length,
              0,
              `a decision email was handed to the sender for ${applicant.email}, whose address was suppressed before this run seeded anything`,
            );
          }
          return;
        }
        // Mail is caught by Mailpit on this target, so the sends really happen
        // and each leaves a row. The row is the evidence: an inbox is not
        // asserted on, because a send that reached the log is a send the
        // deliverability tab can answer for.
        for (const applicant of state.applicants) {
          const rows = await sendRowsFor(applicant.email, 1);
          assert.equal(
            rows.length,
            1,
            `expected one decision email for ${applicant.email}, the send log has ${rows.length}`,
          );
          assert.equal(
            rows[0].kind,
            "admissions",
            "the decision email was logged under the wrong kind, so the deliverability tab cannot answer for this round",
          );
          assert.equal(
            rows[0].referenceId,
            state.roundId,
            "an admissions send is keyed by the ROUND it is about; this row names something else",
          );
          assert.equal(rows[0].status, "sent", "the decision email was not logged as sent");
        }
      });
    } finally {
      await context.close();
      await browser.close();
      recorder.writeMarker();
    }
  },
);
