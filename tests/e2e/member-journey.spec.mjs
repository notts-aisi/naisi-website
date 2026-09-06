/**
 * A member's first day, end to end, in a real browser.
 *
 * The admin approves a waiting applicant on the real Approvals page -> a
 * second account takes the last place in the one-place session -> the new
 * member signs in -> reads their own subscription grid on /profile -> unticks
 * a channel and watches it stick -> takes a place on the course -> meets the
 * full session when they try to move -> leaves the course -> and the two
 * emails the journey caused turn up in the send log.
 *
 * ## How to run it
 *
 *   npm run e2e:browser -- --spec member-journey --local    # a server it starts
 *
 * `scripts/run-e2e.mjs` seeds the throwaway world, leaves its ids in a state
 * file under `.e2e-state/` (or wherever E2E_STATE_DIR points), and tears
 * everything down afterwards.
 *
 * A DEPLOYED target used to be refused by this spec's fixture, because the
 * approval email did not consult the suppression list. `sendEmail()` now
 * checks the list for every send (tests/email-suppression-chokepoint.test.mjs),
 * so the fixture seeds against a deployed target too and the mail step asserts
 * that nothing left. See the "Mail" section of
 * scripts/e2e-fixtures/member-journey.mjs.
 *
 * ## It needs the OWNER'S admin account, and can never make one
 *
 * The first two steps are the whole reason this spec exists: role `member` is
 * a privilege, the harness is forbidden from writing one, and the only honest
 * way to have a member is for an admin to make one on the page a committee
 * actually uses. So `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` come from
 * `.env.e2e.secrets.local`, the runner refuses to seed without them, and this
 * file skips loudly when it is run on its own without them.
 *
 * ## THREE IDENTITIES, THREE CONTEXTS
 *
 * The admin, the new member, and the account that fills the one-place
 * session. Each gets its own browser context so its cookies and its Firebase
 * Auth client state are its own, and nobody has to be signed out for somebody
 * else to act. That matters here rather than being tidiness: the interesting
 * assertions are all about one identity seeing what another just did.
 *
 * ## CHROMIUM ONLY, and that is a limitation rather than a choice
 *
 * Playwright drives Chromium here and nothing else. This codebase has already
 * shipped a Safari-only defect (a `<button>` whose inline background WebKit
 * painted its own grey face over), and Google sign-in is not automatable at
 * all by design. So a green run here is a REGRESSION NET and never a
 * substitute for the manual Safari pass before dev goes to main.
 *
 * ## The headline regression: an empty subscriptions grid
 *
 * Steps five and six are the standing guard on #261. That listener carried
 * one `where` clause, Firestore judges a query by its shape rather than its
 * results, and the rule grants a non-admin read only on
 * `audience == "user" && audienceId == auth.uid`: so the whole listen was
 * denied and every member's Email preferences grid rendered empty. Admins
 * never noticed, because the admin branch of the rule has no such clause,
 * which is exactly why this step is driven AS A MEMBER and the fixture seeds
 * rows that a working grid has to show.
 *
 * ## It writes a completion marker, and the runner insists on it
 *
 * Every way this file can decline to run (no Playwright, no fixture, a skip)
 * still exits `node --test` at 0. So the shared recorder records each step as
 * it finishes and writes the list in the `finally`; `scripts/run-e2e.mjs`
 * deletes that file before the run and refuses to report success unless it
 * comes back naming every step in `SPEC.steps`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTarget, hasAdminCredentials, loadSecrets } from "../../scripts/e2e/lib/env.mjs";
import { readUserDoc } from "../../scripts/e2e/lib/firestore.mjs";
import {
  approvePendingApplicant,
  createStepRecorder,
  newIdentityPage,
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
  subscriptionId,
} from "../../scripts/e2e-fixtures/core.mjs";
import {
  GRID_CHANNELS,
  GRID_CHANNEL_LABELS,
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
  TOGGLED_CHANNEL,
} from "../../scripts/e2e-fixtures/member-journey.mjs";

/**
 * Where this run's ledger and marker live. The runner hands every child an
 * `E2E_STATE_DIR`, and `stateDir()` is the one place that reads it.
 */
const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: dev is a cold Cloud Run. */
const WAIT_MS = 30_000;

/** How often a poll re-asks. Small enough to be quick, big enough to be cheap. */
const POLL_MS = 500;

/**
 * Why a step may not run in this mode, or null.
 *
 * NOTHING ON THIS JOURNEY IS reCAPTCHA-GATED (see
 * `RECAPTCHA_DEPENDENT_STEPS` in the fixture, which is empty and says why), so
 * this always answers null today. The wiring is kept verbatim from the funnel
 * anyway: it is the one skip the runner accepts, and a step that later grows a
 * gated press must be handled the same way here as it is there rather than
 * having the mechanism reinvented under it.
 */
let skipReasonFor = () => null;

/**
 * The one reason this file may record for a step it did not run, shared with
 * the runner through `core.mjs`.
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
    ? `No member-journey fixture at ${STATE_PATH}. Run: npm run e2e:browser -- --spec member-journey.`
    : !hasAdminCredentials()
      ? "E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD are not set. This spec approves an applicant " +
        "on the real Approvals page, and only the owner's own admin account can reach it: " +
        "put both in .env.e2e.secrets.local at the repo root, or export them."
      : null;

/**
 * The origin under test, through the auth harness's own allowlist so a typo
 * cannot aim a run that APPROVES ACCOUNTS at production.
 */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

/**
 * Polls `predicate` until it returns something truthy, and hands that back.
 *
 * Used for the two facts on this journey that no locator can wait on: a
 * client-direct Firestore write the page has no response to show for (the
 * approval), and a fire-and-forget POST the page deliberately does not await
 * (the subscriptions sync, and the drop-out email). A fixed sleep would be
 * either flaky or slow; this is neither, and it says what it waited for when
 * it gives up.
 */
async function waitFor(what, predicate, { timeout = WAIT_MS } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await predicate();
    if (answer) return answer;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${what}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP`.
test(
  "member journey: approved, subscribed, enrolled, moved, gone",
  { skip: skipReason ?? false },
  async (t) => {
    const origin = baseUrl();
    const secrets = loadSecrets();
    const member = state.member;
    const other = state.other;
    const courseUrl = `${origin}/courses/${encodeURIComponent(state.courseId)}`;

    // One browser, three contexts. The admin keeps the first page because it
    // is the one that opens the browser; the other two are peers of it.
    const { browser, context, page: adminPage } = await openBrowser();
    const { context: memberContext, page: memberPage } = await newIdentityPage(browser);
    const { context: otherContext, page: otherPage } = await newIdentityPage(browser);

    /**
     * Which page a failed step should photograph.
     *
     * The recorder takes ONE page and this spec drives three, so a failure on
     * the member's page would otherwise leave a screenshot of whatever the
     * admin was looking at, which is a worse diagnostic than none. The shim
     * below forwards the three calls the recorder makes to whichever page the
     * current step set. Each step sets it as its first line.
     */
    let activePage = adminPage;
    const recorderPage = {
      screenshot: (options) => activePage.screenshot(options),
      locator: (selector) => activePage.locator(selector),
      url: () => activePage.url(),
    };

    const recorder = createStepRecorder({
      t,
      page: recorderPage,
      markerPath: MARKER,
      artifactsDir: ARTIFACTS_DIR,
      // Read through a closure: the mode is only known once the stub below
      // has had its say.
      skipReasonFor: (name) => skipReasonFor(name),
    });
    const step = (name, fn) => recorder.step(name, fn);

    // Local mode only (the helper checks the origin). Nothing on this journey
    // presses a gated control, so this decides the skip mode and otherwise
    // does nothing; it is armed on every page so no context can be the one
    // that reaches for Google's script.
    const recaptchaStubbed = await stubRecaptchaOnLoopback(adminPage, origin);
    await stubRecaptchaOnLoopback(memberPage, origin);
    await stubRecaptchaOnLoopback(otherPage, origin);
    console.log(
      `[journey-spec] reCAPTCHA: ${recaptchaStubbed ? `armed (${recaptchaStubbed})` : "real widget (deployed target)"}`,
    );
    if (!recaptchaStubbed) {
      skipReasonFor = (name) =>
        RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
    }

    // Sign-in is `signInWithPassword` in scripts/e2e/lib/browser.mjs, which waits
    // for the form to hydrate and for the auth card to finish sliding in before it
    // types, then waits for the URL to leave /login.
    const signIn = (pg, credentials) =>
      signInWithPassword(pg, origin, credentials, { timeout: WAIT_MS });

    /** The radio behind one session card, in whichever picker matches first. */
    const slotInput = (pg, groupId) =>
      pg.locator(`input[name="course-session"][value="${groupId}"]`);

    /** The whole card. The radio is clipped to 1px; the label is the target. */
    const slotCard = (pg, groupId) =>
      pg.locator("label").filter({ has: slotInput(pg, groupId) });

    /**
     * Waits until the course page carries EXACTLY ONE `testId`, which is the
     * hero picker's, before a step touches it.
     *
     * The page mounts `CourseCTA` twice (hero and foot), and it used to mount
     * a `GroupPicker` in each, with its own state and its own GET. The count
     * was two, `.first()` only meant "the hero" once both had got there, and a
     * drop-out driven through one left the other offering a place. Only the
     * hero mounts a picker now, so the count is one, and asserting it (rather
     * than waiting for "at least one") is what fails here rather than in a
     * confusing half-driven step if a second picker ever comes back.
     *
     * The `.first()` at the call sites is left in place: it costs nothing
     * against a single match and it keeps every step reading the same way.
     * `tests/e2e-test-ids.test.mjs` names this wrapper in `DYNAMIC_LOCATORS`,
     * so a rename here is a rename there too.
     */
    const onePickerShows = (pg, testId) =>
      waitFor(`the course picker to render ${testId}`, async () =>
        (await pg.getByTestId(testId).count()) === 1 ? true : null,
      );

    /** Every send this run caused to one address, by kind. */
    const sendKindsFor = async (address) => {
      const snap = await fixtureQuery("emailSends").where("to", "==", address).get();
      return snap.docs.map((doc) => String(doc.data()?.kind ?? ""));
    };

    try {
      await step("the admin finds the new applicant waiting for approval", async () => {
        activePage = adminPage;
        await signIn(adminPage, {
          email: secrets.adminEmail,
          password: secrets.adminPassword,
        });
        await adminPage.goto(`${origin}/admin`, { waitUntil: "domcontentloaded" });
        const card = adminPage
          .getByTestId("approval-card")
          .filter({ hasText: member.email })
          .first();
        // Something has to be on the queue before Load more can mean anything.
        await adminPage
          .getByTestId("approval-card")
          .first()
          .waitFor({ timeout: WAIT_MS })
          .catch((err) => {
            throw new Error(
              `no approval cards on ${origin}/admin within ${WAIT_MS}ms. Either the ` +
                "seeded applicant is not waiting, or the signed-in account is not an " +
                `admin and the page redirected. ${err.message}`,
            );
          });
        // The queue paginates 20 at a time, newest first, and dev is shared:
        // another run's applicants can sit above this one. So press Load more
        // until the card is on screen, exactly as an admin scrolling would.
        const loadMore = adminPage.getByRole("button", { name: "Load more" });
        for (let i = 0; i < 10; i += 1) {
          if ((await card.count()) > 0) break;
          if ((await loadMore.count()) === 0) break;
          const before = await adminPage.getByTestId("approval-card").count();
          await loadMore.click();
          await waitFor("the queue to show another page", async () =>
            (await adminPage.getByTestId("approval-card").count()) > before ? true : null,
          );
        }
        await card.waitFor({ timeout: WAIT_MS });
        // The card is the applicant's whole application, so the two things a
        // person decides on have to be on it.
        const text = await card.innerText();
        assert.match(text, /Motivation/, "the approval card showed no motivation to judge");
        assert.match(
          text,
          /automated test fixture/,
          "the approval card showed somebody else's application",
        );
      });

      await step("approving the applicant makes them a member", async () => {
        activePage = adminPage;
        // Through the shared helper rather than by hand: it presses Approve and
        // waits for the queue to drop the row on its own, which is the whole of
        // what an admin sees, and every other spec that ever needs a member has
        // to get one the same way.
        await approvePendingApplicant(adminPage, origin, { email: member.email });

        // The approve is a CLIENT-DIRECT Firestore write
        // (`adminMutations.approveUser`), so the page shows the row leaving and
        // nothing about what it wrote. Reading the document is the only way to
        // see that. This is a READ of something the PRODUCT wrote: the harness
        // never writes a role, which is the whole reason the approval is driven
        // through this page at all.
        const approved = await waitFor(
          "the applicant's user document to say member",
          async () => {
            const doc = await readUserDoc(member.uid);
            return doc && doc.role === "member" ? doc : null;
          },
        );
        assert.ok(
          approved.approvedAt,
          "the approval left no approvedAt stamp, so nothing records when it happened",
        );
        assert.ok(
          approved.approvedBy,
          "the approval left no approvedBy stamp, so nothing records who did it",
        );

        // The queue dropping the row is asserted inside the helper, and it is
        // half of what this step is for. The Approvals list is a ONE-SHOT read
        // (`useOneShotList` in src/features/admin/adminList.tsx uses getDocs,
        // not onSnapshot), so the row only goes when the page asks to read
        // again; it used to ask for nothing, and an approved applicant sat
        // there under a permanently disabled "Approving…" button until the
        // admin pressed Refresh. The card now hands the decision back to the
        // page, and a detach that stops happening brings that back here.
      });

      await step("another sign-up takes the last place in the one-place session", async () => {
        activePage = otherPage;
        // NOT approved, and it does not need to be: the enrol route admits a
        // `pending` caller on purpose (its own module comment says so), which
        // is what lets this fixture fill a session through the real route
        // instead of writing an enrolment row nobody earned.
        await signIn(otherPage, other);
        await otherPage.goto(courseUrl, { waitUntil: "domcontentloaded" });
        await onePickerShows(otherPage, "course-take-place");

        const card = slotCard(otherPage, state.lastSeatGroupId).first();
        await card.waitFor({ timeout: WAIT_MS });
        await waitFor("the one-place session to report its last seat", async () =>
          /1 place left/.test(await card.innerText()) ? true : null,
        );
        // The radio is clipped to 1px by design (the whole card is the label),
        // so the click goes where a person's would: on the card.
        await card.click();
        await otherPage.getByTestId("course-take-place").first().click();
        await otherPage
          .getByText(new RegExp(`You'?re in ${state.lastSeatGroupName}`))
          .first()
          .waitFor({ timeout: WAIT_MS });
      });

      await step("the new member signs in and lands past the pending gate", async () => {
        activePage = memberPage;
        await signIn(memberPage, member);
        // The approval is what decides this. A `pending` account is sent to
        // /pending-approval by (app)/layout.tsx, so landing anywhere else is
        // the member area agreeing with the document the admin wrote.
        assert.notEqual(
          new URL(memberPage.url()).pathname,
          "/pending-approval",
          "the approved member was still held at the pending gate after signing in",
        );
      });

      await step("the profile grid shows the member their own subscriptions", async () => {
        activePage = memberPage;
        await memberPage.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
        const grid = memberPage.getByTestId("profile-subscriptions-grid");
        await grid.waitFor({ timeout: WAIT_MS }).catch((err) => {
          throw new Error(
            "the Email preferences grid never rendered for a member. That is the shape " +
              "of #261: the listener's query has to pin BOTH audience and audienceId, " +
              "because the rule grants a non-admin read only on that pair and Firestore " +
              `judges a listen by its shape rather than its results. ${err.message}`,
          );
        });
        // THE REGRESSION. The fixture seeded a subscribed row per channel, so
        // an empty or unticked grid here means the member cannot see rows that
        // exist. Every box, so a grid that renders one channel and silently
        // drops the other fails too.
        for (const channel of GRID_CHANNELS) {
          const box = grid.getByLabel(
            `${GRID_CHANNEL_LABELS[channel]} to ${member.email}`,
          );
          await box.waitFor({ timeout: WAIT_MS });
          assert.equal(
            await box.isChecked(),
            true,
            `the ${channel} box was unticked for a member who is subscribed to it. A ` +
              "grid that shows nothing is what a denied listen looks like from the " +
              "outside: see #261.",
          );
        }
        assert.equal(
          (await memberPage.getByTestId("profile-subscriptions-badge").innerText()).trim(),
          "Subscribed",
          "the badge said the member has no subscriptions while their rows say otherwise",
        );
      });

      await step("unticking a channel writes it through and survives a reload", async () => {
        activePage = memberPage;
        const label = `${GRID_CHANNEL_LABELS[TOGGLED_CHANNEL]} to ${member.email}`;
        await memberPage
          .getByTestId("profile-subscriptions-grid")
          .getByLabel(label)
          .uncheck();
        await memberPage.getByRole("button", { name: "Save changes" }).click();
        await memberPage.getByText("Saved.", { exact: true }).waitFor({ timeout: WAIT_MS });

        // "Saved." is the USER DOCUMENT write. The subscriptions sync is a
        // separate, deliberately un-awaited POST, so the row lands a moment
        // later and only Firestore can say when.
        const row = await waitFor("the subscription row to record the untick", async () => {
          const snap = await fixtureDoc(
            "subscriptions",
            subscriptionId(member.email, TOGGLED_CHANNEL),
          ).get();
          const data = snap.exists ? snap.data() : null;
          return data && data.subscribed === false ? data : null;
        });
        // The two axes are orthogonal and this is the half that must not move:
        // unsubscribing does not un-prove an inbox, and a row that lost
        // `confirmed` would ask the member to click a confirmation link again
        // the next time they tick the box.
        assert.equal(
          row.confirmed,
          true,
          "unticking a channel cleared `confirmed`, so the member's proven inbox was " +
            "forgotten along with their preference",
        );
        assert.ok(row.unsubscribedAt, "the untick left no unsubscribedAt in the audit trail");

        await memberPage.reload({ waitUntil: "domcontentloaded" });
        const grid = memberPage.getByTestId("profile-subscriptions-grid");
        await grid.waitFor({ timeout: WAIT_MS });
        assert.equal(
          await grid.getByLabel(label).isChecked(),
          false,
          "the unticked channel came back ticked after a reload",
        );
        const kept = GRID_CHANNELS.find((c) => c !== TOGGLED_CHANNEL);
        assert.equal(
          await grid
            .getByLabel(`${GRID_CHANNEL_LABELS[kept]} to ${member.email}`)
            .isChecked(),
          true,
          `unticking ${TOGGLED_CHANNEL} also switched off ${kept}`,
        );
        // Still subscribed, because one channel is still on. The badge counts
        // the grid and nothing else.
        assert.equal(
          (await memberPage.getByTestId("profile-subscriptions-badge").innerText()).trim(),
          "Subscribed",
          "the badge read as unsubscribed while a channel was still ticked",
        );
      });

      await step("taking a place on the course confirms the session", async () => {
        activePage = memberPage;
        await memberPage.goto(courseUrl, { waitUntil: "domcontentloaded" });
        await onePickerShows(memberPage, "course-take-place");

        const mine = slotCard(memberPage, state.roomyGroupId).first();
        const full = slotCard(memberPage, state.lastSeatGroupId).first();
        await mine.waitFor({ timeout: WAIT_MS });
        // The picker refreshes its numbers off its own GET, so the seat counts
        // the server rendered may be a moment behind what the other account
        // just did.
        await waitFor("the picker's seat counts to catch up", async () =>
          /2 places left/.test(await mine.innerText()) &&
          /Full/.test(await full.innerText())
            ? true
            : null,
        );
        await mine.click();
        await memberPage.getByTestId("course-take-place").first().click();
        // The confirmation sentence, not the session name on its own: the name
        // is also in the list this branch replaces, so matching it alone would
        // pass against the page that was already on screen.
        await memberPage
          .getByText(new RegExp(`You'?re in ${state.roomyGroupName}`))
          .first()
          .waitFor({ timeout: WAIT_MS });
      });

      await step("the full session cannot be chosen when changing session", async () => {
        activePage = memberPage;
        // Reloaded on purpose: this is the member coming back later, and the
        // reload is what settles the picker's state for the rest of this step.
        await memberPage.reload({ waitUntil: "domcontentloaded" });
        await onePickerShows(memberPage, "course-change-session");
        await memberPage.getByTestId("course-change-session").first().click();

        const list = memberPage.getByTestId("course-slot-list").first();
        await list.waitFor({ timeout: WAIT_MS });
        const full = list.locator(
          `input[name="course-session"][value="${state.lastSeatGroupId}"]`,
        );
        await full.waitFor({ timeout: WAIT_MS });
        assert.equal(
          await full.isDisabled(),
          true,
          "the full session was offered as a choice. The picker greys it out with the " +
            "same predicate the enrol transaction refuses on, so a live control here " +
            "is an invitation to a 409.",
        );
        assert.match(
          await list.innerText(),
          /Full/,
          "the full session was not labelled Full, so nothing on screen says why it " +
            "cannot be picked",
        );
        // The session you are already in is never full to you: you are one of
        // the people filling it.
        assert.equal(
          await list
            .locator(`input[name="course-session"][value="${state.roomyGroupId}"]`)
            .isDisabled(),
          false,
          "the member's own session was disabled, so re-saving it would be impossible",
        );
        assert.equal(
          await memberPage
            .getByRole("button", { name: "Move to this session" })
            .first()
            .isDisabled(),
          true,
          "the move button was live before any session had been chosen",
        );

        await memberPage.getByRole("button", { name: "Keep my session" }).first().click();
        // NOT the "You're in ..." sentence: that paragraph sits ABOVE the
        // change controls and is on screen throughout the changing branch too,
        // so waiting for it would be satisfied before the click and this
        // cancel would go unasserted. The timetable closing is the thing that
        // only happens after it: the hero goes back to offering Change
        // session, and no slot list is showing on the page any more.
        await onePickerShows(memberPage, "course-change-session");
        await waitFor("the session timetable to close again", async () =>
          (await memberPage.getByTestId("course-slot-list").count()) === 0 ? true : null,
        );
        // And the place they kept is the one they had. Read AFTER the
        // timetable closed, so this is the state the cancel left behind
        // rather than the sentence that was already on screen before it.
        await memberPage
          .getByText(new RegExp(`You'?re in ${state.roomyGroupName}`))
          .first()
          .waitFor({ timeout: WAIT_MS });
      });

      await step("leaving the course needs the typed course title", async () => {
        activePage = memberPage;
        await onePickerShows(memberPage, "dropout-reveal");
        await memberPage.getByTestId("dropout-reveal").first().click();

        const leave = memberPage.getByTestId("dropout-leave").first();
        await leave.waitFor({ timeout: WAIT_MS });
        assert.equal(
          await leave.isDisabled(),
          true,
          "the leave button was live before the course title was typed",
        );
        const confirm = memberPage.locator("#dropout-confirm").first();
        // Byte equality on both sides, so a near miss must not do it either.
        await confirm.fill(`${state.courseTitle} `);
        assert.equal(
          await leave.isDisabled(),
          true,
          "a trailing space was accepted as the course title. The server compares bytes, " +
            "so a form that accepts an approximation is a form that gets a refusal.",
        );
        await confirm.fill(state.courseTitle);
        await leave.click();

        // Dropping out is irreversible FROM HERE by decision, so the picker
        // does not come back offering a place: it says the seat has gone back
        // to the group, and the way out is gone with it.
        await memberPage.getByText(/You'?re off the course/).first().waitFor({ timeout: WAIT_MS });
        await memberPage
          .getByText(/Signing up again isn'?t something you can do here/)
          .first()
          .waitFor({ timeout: WAIT_MS });
        // The foot placement is deliberately NOT asserted on. It mounts no
        // picker at all now (it links up to the hero one), and that there is
        // exactly one picker on the page after a drop-out is asserted once, in
        // tests/e2e/applicant-funnel.spec.mjs's last step. One assertion is
        // enough: a second copy here would be a second place to edit the next
        // time the page's call to action moves.
      });

      await step("the approval and the drop-out reach the send log", async () => {
        activePage = memberPage;
        if (state.suppress) {
          // A deployed target: the fixture wrote suppression rows before
          // anything ran and `sendEmail()` holds every message addressed to a
          // suppressed recipient, so no send row may exist for these addresses.
          //
          // Suppressed mode: seeding wrote a `suppressedEmails` row for every
          // fixture address BEFORE anything ran, so a helper that consults the
          // list sends nothing. `sendCourseDroppedOutEmail` is such a helper
          // (it returns early on `isSuppressed`), so this must be empty.
          const kinds = await sendKindsFor(member.email);
          assert.deepEqual(
            kinds.filter((k) => k === "course-enrolment"),
            [],
            "a drop-out email was sent to a suppressed address, so the suppression row " +
              "seeding writes first is no longer stopping it",
          );
          // The approval email is NOT covered by that promise, which is the
          // whole reason this branch cannot be reached: seeding refuses the
          // mode rather than letting the send happen and asserting about it
          // afterwards. Nothing is asserted here about the approval mail
          // because in this mode there is no safe way to have caused it. The
          // rows are counted and drained by the fixture manifest either way.
        } else {
          // Caught mode: the mail really goes, into Mailpit on this machine,
          // and each send logs a row. The drop-out send is fire and forget, so
          // the row lands after the browser was answered.
          const kinds = await waitFor("the drop-out email to reach the send log", async () => {
            const found = await sendKindsFor(member.email);
            return found.includes("course-enrolment") ? found : null;
          });
          assert.ok(
            kinds.includes("application"),
            "approving an applicant sent them no application email. The Approvals page " +
              "fires /api/admin/application-emails/send from its Approve handler, and " +
              "that route needs an applicationEmailTemplates/application-approved " +
              `document in this project to have anything to send. Kinds found: ${JSON.stringify(kinds)}.`,
          );
        }
        // Taking a seat mails nobody, in either mode: the enrol route's POST
        // sends nothing at all, and the account that filled the one-place
        // session never reached any other send.
        assert.deepEqual(
          await sendKindsFor(other.email),
          [],
          "signing up for a session sent mail. Nothing on the enrol route's POST path " +
            "sends, so a row here is a send nobody asked for and nothing counts.",
        );
      });
    } finally {
      await memberContext.close();
      await otherContext.close();
      await context.close();
      await browser.close();
      recorder.writeMarker();
    }
  },
);
