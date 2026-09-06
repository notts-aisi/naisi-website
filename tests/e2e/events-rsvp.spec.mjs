/**
 * The public events RSVP flow, end to end, in a real browser, signed out.
 *
 * The event page -> fill the form including its custom question -> submit ->
 * the confirmation page -> the row, the counter and the email behind it ->
 * the same page at two phone viewports.
 *
 * ## Why this one is worth a browser
 *
 * `src/features/events/FormRenderer.tsx` was restructured in September 2026,
 * and it is shared: the same renderer paints the RSVP form, the change-request
 * form and the admissions application. `docs/mobile-baseline-events.md` calls
 * the public RSVP flow the site's hard do-not-regress mobile surface, records
 * that the baseline is walked BY HAND, and carries an owed re-verification
 * that nobody has cleared. So the two halves this file asserts are exactly the
 * two nobody has re-checked together since the restructure: that a guest can
 * still complete the form, and that the page still fits a phone.
 *
 * ## How to run it
 *
 *   npm run e2e:browser -- --spec events-rsvp            # deployed dev
 *   npm run e2e:browser -- --local --spec events-rsvp    # a server it starts
 *
 * `scripts/run-e2e.mjs` seeds the throwaway event, leaves its ids in a state
 * file under `.e2e-state/` (or wherever E2E_STATE_DIR points), and tears
 * everything down afterwards. Running this file on its own is supported
 * (`node --test tests/e2e/events-rsvp.spec.mjs`) but only once a seed exists:
 * it reads the state file and skips loudly when there is none.
 *
 * ## CHROMIUM ONLY, and that is a limitation rather than a choice
 *
 * Playwright drives Chromium here and nothing else. This codebase has already
 * shipped a Safari-only defect (a `<button>` whose inline background WebKit
 * painted its own grey face over), and the mobile baseline explicitly asks for
 * a real-device walk because DevTools does not model the notch inset or the
 * iOS keyboard. So the two viewport steps below are a REGRESSION NET on the
 * one thing a headless browser can answer honestly, which is layout geometry,
 * and they retire none of the hand walk in that document.
 *
 * ## The viewport steps assert, they do not compare screenshots
 *
 * A screenshot baseline of this surface would go red on a font swap, a date
 * that renders one character wider, and every deliberate copy change. The two
 * facts worth pinning are the two the baseline document states as rules: no
 * horizontal document scroll, and no clipped or covered control. Both are
 * measurable, so both are measured.
 *
 * ## It writes a completion marker, and the runner insists on it
 *
 * Every way this file can decline to run (no Playwright, no fixture, a skip)
 * still exits `node --test` at 0, which is indistinguishable from a pass. So
 * the shared recorder records each step as it finishes and writes the list in
 * the `finally`; `scripts/run-e2e.mjs` deletes that file before the run and
 * refuses to report success unless it comes back naming every step in
 * `SPEC.steps`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTarget } from "../../scripts/e2e/lib/env.mjs";
import {
  createStepRecorder,
  newIdentityPage,
  openBrowser,
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
} from "../../scripts/e2e-fixtures/events-rsvp.mjs";

/**
 * Where this run's ledger and marker live. The runner hands every child an
 * `E2E_STATE_DIR`, and `stateDir()` is the one place that reads it; a
 * hand-driven `node --test` on this file alone falls back to the directory the
 * fixture writes to by default.
 */
const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: dev is a cold Cloud Run,
 *  and a dev server compiles a page on its first request. */
const WAIT_MS = 30_000;

/**
 * How long the hop to the confirmation page may take.
 *
 * Longer than a locator wait on purpose. `router.push` sends the browser to a
 * route nothing has visited yet, so against a DEV server that request pays for
 * the page's first compile, and against a deployed backend it can pay for a
 * cold start. Neither is the RSVP being slow, and failing at thirty seconds
 * would report a compile as a broken submit.
 */
const NAV_MS = 60_000;

/**
 * The two phone viewports `docs/mobile-baseline-events.md` names first: the
 * narrow-phone reference and the most common large phone. The iPad and
 * landscape entries in that document stay a hand walk, because what they test
 * (the `--bp-md` transition, and a notch inset that DevTools does not model)
 * is not what a headless viewport can answer.
 */
const PHONES = [
  { label: "375 by 667", width: 375, height: 667 },
  { label: "414 by 896", width: 414, height: 896 },
];

/**
 * Why a step may not run in this mode, or null.
 *
 * Nothing on this journey presses a reCAPTCHA-gated control, so
 * `RECAPTCHA_DEPENDENT_STEPS` is empty and this stays the null-returning
 * default in both modes. The wiring is here in full anyway, in the shape every
 * spec uses, so a future gated step is one entry in the fixture's list away
 * rather than a reimplementation of the skip protocol.
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
 * Playwright is NOT a dependency of this repo, deliberately.
 *
 * The root `package.json` is what App Hosting runs `npm ci` against on the
 * critical path of every production deploy, and a browser-automation library
 * plus its downloaded Chromium has no business there. So it is resolved at
 * runtime and a missing one is a SKIP with the install line, not a red suite.
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
    ? `No events-rsvp fixture at ${STATE_PATH}. Run: npm run e2e:browser -- --spec events-rsvp.`
    : null;

/**
 * The origin under test, through the auth harness's own allowlist so a typo
 * cannot aim a run that CREATES RSVPS at production. Resolved lazily so a
 * skipped run never has to have a target at all.
 */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

/**
 * Waits for a Firestore row a fire-and-forget send writes after the browser
 * has already been answered.
 *
 * `POST /api/events/[id]/rsvp` returns as soon as the transaction commits and
 * calls `sendRsvpEmail()` without awaiting it, on purpose: a slow SMTP must
 * not fail an attendee's RSVP. So the `emailSends` row lands some time after
 * the confirmation page, and a single read would be a coin toss. Returns the
 * documents, or an empty array once the deadline passes.
 */
async function waitForSendRows(email, { timeout = WAIT_MS } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const snap = await fixtureQuery("emailSends").where("to", "==", email).get();
    if (snap.size > 0) return snap.docs.map((d) => d.data());
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Waits until React has actually hydrated the RSVP form.
 *
 * The page is server-rendered, so the form exists in the markup long before
 * anything is listening to it. That window used to be a trap: pressing Submit
 * in it ran the browser's own default submission, the values React never saw
 * were lost, and the page came back looking untouched with no error anywhere
 * for a spec to read. Two runs of this file lost to that on a dev server busy
 * compiling for five other specs. The form now disables its submit until it is
 * live and reads its name and email boxes out of the DOM, so neither loss is
 * reachable; this stays because it is the difference between naming the page
 * as never live and reporting it as a click that timed out, and because
 * FormRenderer's questions below are still React-controlled.
 *
 * The probe is React's own bookkeeping: `precacheFiberNode` puts a
 * `__reactFiber$<key>` property on every host node it hydrates, and server
 * markup carries none. Coupled to a React internal on purpose, because the
 * alternatives are worse: a fixed sleep is a guess, and every public signal
 * (a network idle, a load event) answers a different question than "is this
 * form live yet". If React ever renames it this times out and says the page
 * never hydrated, which is a loud failure pointing straight at this comment.
 */
async function waitForHydration(page, testId, { timeout = WAIT_MS } = {}) {
  await page
    .waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
      },
      testId,
      { timeout, polling: 100 },
    )
    .catch((err) => {
      throw new Error(
        `[data-testid="${testId}"] was still un-hydrated ${timeout}ms after the page ` +
          "loaded, so pressing anything in it would run the browser's default form " +
          `submission instead of the app's. ${err.message}`,
      );
    });
}

/**
 * How long a filled field is given to be overwritten before it is read back.
 *
 * A read-back with no settle proves nothing about a render that is about to
 * land, and what is being waited for (React deciding to write over the DOM)
 * leaves no locator behind to wait on.
 */
const SETTLE_MS = 200;

/**
 * Asserts that a field still holds what was typed into it.
 *
 * This used to be a retry loop that refilled up to a whole timeout's worth of
 * attempts, because the RSVP form's boxes were controlled with no
 * `defaultValue`: a value typed before the bundle hydrated was discarded by
 * React's first render, the field went silently blank, and the submit that
 * followed was refused by the browser's own `required` check with no message a
 * spec could read. The second run of this file hit exactly that. The name and
 * email boxes are uncontrolled now and read from the DOM at submit, so the
 * value holds whenever it was typed, and this asserts that rather than working
 * around the opposite.
 */
async function assertKept(locator, value, what) {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  assert.equal(
    await locator.inputValue(),
    value,
    `${what} did not keep what was typed into it, so a guest filling this form loses ` +
      "their answer to a render they cannot see",
  );
}

/**
 * The measurements the mobile baseline's two rules turn into.
 *
 * `scrollWidth <= innerWidth` is the baseline's "no horizontal page scroll".
 * The rest answers "no clipped controls" for the one control that matters
 * here: where the submit button sits after the page has been scrolled to it,
 * and what is actually painted on top of its centre. `elementFromPoint` is the
 * part a bounding box alone cannot give: a sticky bar sitting over the button
 * leaves the box exactly where it was and the tap going somewhere else.
 */
async function measure(page, testId) {
  return page.getByTestId(testId).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      // The width the document actually has to fit into. NOT the same as
      // `innerWidth`, which counts the vertical scrollbar's gutter: on a page
      // that scrolls down (every event page does) the two differ by the
      // scrollbar's width, and comparing against the larger of them would let
      // that many pixels of real horizontal overflow through unnoticed.
      clientWidth: document.documentElement.clientWidth,
      innerHeight: window.innerHeight,
      left: box.x,
      right: box.x + box.width,
      top: box.y,
      bottom: box.y + box.height,
      width: box.width,
      height: box.height,
      // What the person's finger would land on, described well enough to read
      // in a failure message without a screenshot.
      covered: !(hit && el.contains(hit)),
      coveredBy: hit ? `${hit.tagName.toLowerCase()}.${hit.className || "(no class)"}` : "nothing",
    };
  });
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP` and counts
// it as skipped, which reads as a run that never happened.
test("events RSVP: a signed-out guest books a place and the page fits a phone", { skip: skipReason ?? false }, async (t) => {
  const origin = baseUrl();
  const eventUrl = `${origin}/events/${encodeURIComponent(state.eventId)}`;

  // The shared opener: Chromium at the desktop viewport. The phone steps below
  // open their own contexts rather than resizing this one, so the desktop
  // journey and the narrow layouts never share a scroll position or a cookie.
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
  // Armed for the shape, not for this journey: no page here mounts a reCAPTCHA
  // widget and the RSVP route asks for no token. Kept so every spec decides
  // its mode the same way and the answer is printed either way.
  const recaptchaStubbed = await stubRecaptchaOnLoopback(page, origin);
  console.log(
    `[events-rsvp-spec] reCAPTCHA: ${recaptchaStubbed ? `armed (${recaptchaStubbed})` : "real widget (deployed target)"}; ` +
      `${RECAPTCHA_DEPENDENT_STEPS.length} step(s) depend on it.`,
  );
  if (!recaptchaStubbed) {
    skipReasonFor = (name) =>
      RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
  }

  const answer = `A poster in Highfield House (run ${state.rsvpRunId}).`;
  /** Filled in by the submit step and read by the two after it. */
  let rsvpId = null;

  try {
    await step("the event page shows the title, the when, the where and the RSVP form", async () => {
      await page.goto(eventUrl, { waitUntil: "domcontentloaded" });
      await page
        .getByRole("heading", { name: state.eventTitle })
        .waitFor({ timeout: WAIT_MS });
      // The machine-readable instant rather than the rendered sentence: the
      // page formats with `toLocaleString`, so asserting on the words would be
      // asserting on the runner's locale and timezone. `<time datetime>` is
      // the same fact without either.
      await page
        .locator(`time[datetime="${state.startAtIso}"]`)
        .first()
        .waitFor({ timeout: WAIT_MS });
      await page.getByText(state.location, { exact: false }).first().waitFor({ timeout: WAIT_MS });

      // The form itself, and the custom question inside it. A public event
      // must render the form to a signed-out visitor: the members-only branch
      // would put a sign-in gate here instead, and that is the difference
      // between a guest RSVP working and nobody being able to book at all.
      const form = page.getByTestId("rsvp-form");
      await form.waitFor({ timeout: WAIT_MS });
      await page.getByText(state.questionLabel, { exact: false }).first().waitFor({ timeout: WAIT_MS });
      await page.locator(`#${state.questionId}-input`).waitFor({ timeout: WAIT_MS });
      assert.equal(
        await page.getByRole("heading", { name: "Members-only event" }).count(),
        0,
        "the public event page put the members-only sign-in gate in front of a signed-out " +
          "visitor, so nobody without an account could book a place",
      );
    });

    await step("a guest fills the form and lands on the confirmation page", async () => {
      // The two identity boxes are filled BEFORE the page is known to be live,
      // deliberately racing hydration: they are uncontrolled, so a guest who
      // starts typing into the server-rendered markup keeps what they typed,
      // and losing that race is what this step is here to notice.
      const nameBox = page.locator("#rsvp-name");
      const emailBox = page.locator("#rsvp-email");
      await nameBox.fill(state.guestName);
      await emailBox.fill(state.guestEmail);
      await waitForHydration(page, "rsvp-form");
      await assertKept(nameBox, state.guestName, "the name box");
      await assertKept(emailBox, state.guestEmail, "the email box");
      // The custom question comes after: FormRenderer's fields are still
      // React-controlled, because the same renderer paints the admissions
      // application and the change-request form. The submit button carrying
      // `disabled` until the form is live is what protects them from an early
      // press; nothing protects an early keystroke, so this does not try one.
      const questionBox = page.locator(`#${state.questionId}-input`);
      await questionBox.fill(answer);
      await assertKept(questionBox, answer, "the custom question");
      // The mailing-list tick boxes are deliberately left alone. They post to
      // a different route, and a smoke test that opts a throwaway address into
      // two channels is a smoke test with two more collections to drain.
      await page.getByTestId("rsvp-submit").click();
      // The route sends the browser to its own page rather than swapping the
      // card in place, so the URL is the assertion: a person who lands back on
      // the event page with a cleared form has no idea whether it went.
      //
      const navFailure = await page
        .waitForURL(
          (url) => url.pathname.endsWith(`/events/${state.eventId}/rsvp/submitted`),
          { timeout: NAV_MS },
        )
        .then(() => null)
        .catch((err) => err.message);
      if (navFailure !== null) {
        // The form's other answer. A refusal (a duplicate RSVP, a cancelled
        // event, a paused signup surface) leaves the URL alone and puts a
        // sentence under the fields, so reporting only the navigation timeout
        // would name neither the refusal nor its reason.
        const refusal = page.getByTestId("rsvp-error");
        const said = (await refusal.count()) > 0 ? (await refusal.innerText()).trim() : null;
        assert.fail(
          said
            ? `the RSVP was refused in place: ${said}`
            : `the browser never reached the confirmation page and the form said nothing: ${navFailure}`,
        );
      }
      const headline = page.getByTestId("rsvp-submitted");
      await headline.waitFor({ timeout: WAIT_MS });
      assert.equal(
        (await headline.innerText()).trim(),
        "Your RSVP is in",
        "the confirmation page did not say the RSVP is in",
      );
      // Named, not generic: the page reads the event back out of Firestore, so
      // this sentence is also the proof it found the right one.
      await page
        .getByText(`Your RSVP for ${state.eventTitle} has been submitted`, { exact: false })
        .waitFor({ timeout: WAIT_MS });
      // The RSVP lands PENDING (the route hard-codes it; capacity and waitlist
      // are decided at approval), so the page must promise a follow-up rather
      // than a place.
      await page.getByText(/will review it and email you/).waitFor({ timeout: WAIT_MS });
    });

    await step("the RSVP row carries the guest's answer and the event's pending count moved", async () => {
      const snap = await fixtureQuery("eventRsvps")
        .where("eventId", "==", state.eventId)
        .get();
      assert.equal(
        snap.size,
        1,
        `expected exactly one RSVP row for ${state.eventId}, found ${snap.size}`,
      );
      const row = snap.docs[0].data();
      rsvpId = snap.docs[0].id;
      assert.equal(row.email, state.guestEmail, "the RSVP row is against another address");
      assert.equal(row.name, state.guestName, "the RSVP row lost the name the guest typed");
      assert.equal(
        row.status,
        "pending",
        "a new RSVP must land pending: capacity and the waitlist are decided at approval",
      );
      assert.equal(
        row.uid,
        null,
        "a signed-out RSVP must carry no uid, or it would be attributed to somebody",
      );
      assert.equal(
        row.answers?.[state.questionId],
        answer,
        "the custom question's answer did not reach Firestore",
      );

      const eventSnap = await fixtureDoc("events", state.eventId).get();
      assert.equal(
        eventSnap.data()?.rsvpCountPending,
        1,
        "the event's pending RSVP count did not move, so the organiser's numbers are wrong",
      );
    });

    await step("the confirmation email is accounted for", async () => {
      if (state.suppress) {
        // Suppressed mode: the fixture wrote a `suppressedEmails` row before
        // the event existed, and `sendRsvpEmail()` returns early on it. The
        // assertion is that NOTHING was sent, which is what stops a run
        // against a server with real credentials bouncing a `.invalid`
        // address off the sending domain. A wait first, so this cannot pass
        // by reading Firestore before a send would have logged anything.
        const rows = await waitForSendRows(state.guestEmail, { timeout: 5_000 });
        assert.equal(
          rows.length,
          0,
          `${rows.length} email(s) were logged to a suppressed fixture address. The ` +
            "suppression row did not stop the send, so this run handed mail to a real sender.",
        );
        return;
      }
      const rows = await waitForSendRows(state.guestEmail);
      assert.equal(
        rows.length,
        1,
        `expected one confirmation email to ${state.guestEmail}, found ${rows.length}. ` +
          "Mail is caught on this target, so a missing row means the route did not send " +
          "(check the server log for [rsvp email:requested]).",
      );
      const row = rows[0];
      assert.equal(row.kind, "rsvp", "the confirmation was logged under the wrong kind");
      assert.equal(row.status, "sent", `the confirmation email is logged as ${row.status}`);
      assert.equal(
        row.referenceId,
        rsvpId,
        "the send is not cross-referenced to the RSVP it confirms, so the deliverability " +
          "tab cannot answer whether this attendee was written to",
      );
      assert.ok(
        String(row.subject ?? "").includes(state.eventTitle),
        `the confirmation subject does not name the event: ${JSON.stringify(row.subject)}`,
      );
    });

    /**
     * One phone viewport, walked and measured.
     *
     * A named function called from two LITERAL step() names rather than a loop
     * over `PHONES` building its names with a template: the completion marker
     * is matched against `SPEC.steps` by name, and a guard reads the step names
     * off this file's source. A generated name is a name neither can see.
     */
    const walkPhone = async (phone) => {
      // A fresh context per viewport rather than a resize: a context carries
      // its viewport from birth, and a page that laid out wide and was then
      // narrowed is not the page a person on a phone gets.
      const { context: phoneContext, page: phonePage } = await newIdentityPage(browser, {
        viewport: { width: phone.width, height: phone.height },
      });
      try {
        await phonePage.goto(eventUrl, { waitUntil: "domcontentloaded" });
        await phonePage.getByTestId("rsvp-form").waitFor({ timeout: WAIT_MS });
        const submit = phonePage.getByTestId("rsvp-submit");
        // Scrolled to, because that is what a person does: the button sits
        // below the fold on any phone, and the question is whether it is usable
        // once reached rather than whether it starts on screen.
        await submit.scrollIntoViewIfNeeded();
        assert.equal(await submit.isVisible(), true, "the RSVP submit button is not visible");

        const m = await measure(phonePage, "rsvp-submit");
        // Both comparisons, because they are two different claims and only the
        // stricter one is the rule the baseline document states. `innerWidth`
        // is the viewport including the scrollbar gutter, so a page overflowing
        // by less than a scrollbar's width passes that one while a phone still
        // scrolls sideways; `clientWidth` is the width the content really has.
        assert.ok(
          m.scrollWidth <= m.innerWidth,
          `the event page overflows its viewport at ${phone.label}: the document is ` +
            `${m.scrollWidth}px wide inside a ${m.innerWidth}px window.`,
        );
        assert.ok(
          m.scrollWidth <= m.clientWidth,
          `the event page scrolls horizontally at ${phone.label}: the document is ` +
            `${m.scrollWidth}px wide with only ${m.clientWidth}px to lay out in. ` +
            "docs/mobile-baseline-events.md makes no horizontal page scroll the first rule " +
            "of this surface.",
        );
        assert.ok(
          m.left >= 0 && m.right <= m.innerWidth + 1,
          `the RSVP submit button is clipped horizontally at ${phone.label}: it spans ` +
            `${m.left} to ${m.right} in a ${m.innerWidth}px viewport.`,
        );
        assert.ok(
          m.top >= 0 && m.bottom <= m.innerHeight + 1,
          `the RSVP submit button is not fully on screen at ${phone.label} after being ` +
            `scrolled to: it spans ${m.top} to ${m.bottom} in a ${m.innerHeight}px viewport.`,
        );
        assert.equal(
          m.covered,
          false,
          `something is painted over the RSVP submit button at ${phone.label}: a tap at its ` +
            `centre lands on ${m.coveredBy}.`,
        );
      } finally {
        await phoneContext.close();
      }
    };

    await step("the event page fits a 375 by 667 phone with its submit button reachable", () =>
      walkPhone(PHONES[0]),
    );

    await step("the event page fits a 414 by 896 phone with its submit button reachable", () =>
      walkPhone(PHONES[1]),
    );
  } finally {
    await context.close();
    await browser.close();
    recorder.writeMarker();
  }
});
