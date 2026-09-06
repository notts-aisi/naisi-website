/**
 * Helpers for the BROWSER-driven specs under tests/e2e (the Playwright ones),
 * shared so every spec relaxes the same thing in the same way, and only on a
 * server this harness started itself.
 *
 * ## The reCAPTCHA stub, and why it is a stub rather than a test key
 *
 * `scripts/e2e/run.mjs` hands the local server Google's always-pass reCAPTCHA
 * SECRET, so `siteverify` accepts any token string. The fetch-based batteries
 * simply post a junk token. A browser cannot: the client widget
 * (`RecaptchaInvisible`) obtains its token from Google's `api.js`, and once a
 * secret is set the server treats a missing token as a refusal. Google's
 * published test SITE key does not help, because it is a v2 Checkbox key and
 * the widget renders as Invisible, which fails with "Invalid key type" and
 * yields nothing (the component's own comment says as much). The applicant
 * funnel's first two real runs both stopped there, at "We could not confirm
 * you are a person".
 *
 * So the relaxation is moved to where the fetch batteries already have it:
 * this helper intercepts the `api.js` request in Playwright and serves a
 * fifteen-line `grecaptcha` that calls back a fixed token, which the
 * always-pass secret then accepts. Nothing here touches product code, and
 * nothing here is reachable outside a Playwright page.
 *
 * ## It only arms on loopback
 *
 * Against dev.naisi.uk the deployed server holds a REAL secret, a stubbed
 * token would be refused, and more importantly the point of dev mode is to
 * prove the real widget and the real secret agree. The helper therefore
 * checks the target origin and does nothing unless it is loopback, the same
 * test `lib/env.mjs` applies to the per-run token secret.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLoopbackOrigin, loadSecrets } from "./env.mjs";

/** Every locator in these helpers waits at most this long. Generous: a
 *  deployed dev backend is a cold Cloud Run. */
const WAIT_MS = 30_000;

/**
 * How long the sign-in HANDOFF gets, which is longer than a locator's patience
 * because it is four things rather than one: Firebase mints an id token,
 * /api/auth/session turns it into a cookie, the app pushes at a route, and a
 * dev server may still be compiling that route while other specs keep it busy.
 */
const SIGN_IN_HANDOFF_MS = 120_000;

/** How long a fill is given to survive before it is read back. */
const FILL_SETTLE_MS = 500;

/**
 * The viewport every browser spec gets unless it says otherwise.
 *
 * A desktop size on purpose: the admissions availability grid renders one day
 * at a time below 48rem and all seven columns above it, and the funnel drags
 * down a column that only exists in the wide layout. Specs that want the
 * mobile layout ask for it explicitly, so the default never drifts.
 */
export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

/** The URL the widget loads. Pinned to what `RecaptchaInvisible` appends. */
export const RECAPTCHA_SCRIPT_URL = "https://www.google.com/recaptcha/api.js";

/** What the stub hands back on loopback. Any string passes under the always-pass secret. */
export const LOOPBACK_RECAPTCHA_TOKEN = "e2e-loopback-recaptcha-token";

/**
 * The header the dev backend's harness bypass reads. Pinned to
 * `RECAPTCHA_BYPASS_HEADER` in src/lib/recaptcha/bypass.ts; the guard in
 * tests/funnel-harness-guards.test.mjs compares the two.
 */
export const RECAPTCHA_BYPASS_HEADER = "x-e2e-recaptcha-bypass";

/**
 * The class the REAL invisible widget gives the element it injects into its
 * container. The stub injects one too, so a spec can wait for "the widget is
 * mounted and can be asked" with one locator in both modes.
 */
export const RECAPTCHA_BADGE_SELECTOR = ".grecaptcha-badge";

/**
 * The stand-in `api.js`. Mirrors exactly the surface `RecaptchaInvisible`
 * uses: `render` returns a widget id, remembers the callback and injects the
 * badge element the real widget would; `execute` calls back asynchronously
 * (the real widget is async, and the component sets its pending resolver
 * before calling execute); `reset` is a no-op.
 */
function recaptchaStub(token) {
  return `
(() => {
  const widgets = [];
  window.grecaptcha = {
    render(container, params) {
      widgets.push(params);
      if (container && typeof document !== "undefined") {
        const badge = document.createElement("div");
        badge.className = "grecaptcha-badge";
        badge.dataset.e2eStub = "true";
        container.appendChild(badge);
      }
      return widgets.length - 1;
    },
    execute(id) {
      const widget = widgets[id ?? 0];
      if (widget && typeof widget.callback === "function") {
        setTimeout(() => widget.callback(${JSON.stringify(token)}), 0);
      }
    },
    reset() {},
  };
})();
`;
}

/**
 * Arms whatever lets this page through the reCAPTCHA gate on this target, and
 * says which. Returns one of:
 *
 *  - "stubbed": the target is loopback. The stub above is served in place of
 *    Google's script and hands back a fixed token, which the always-pass
 *    secret the local server runs with accepts. Nothing else is needed.
 *  - "bypass": the target is deployed and `.env.e2e.secrets.local` (or the
 *    environment) carries E2E_RECAPTCHA_BYPASS_SECRET. Every request from
 *    this page's context carries the bypass header, and the stub hands the
 *    widget an EMPTY token, so the request that reaches the gate is
 *    tokenless: the gate consults the bypass only for a tokenless request
 *    (src/lib/recaptcha/bypass.ts), and it grants only when the header
 *    matches the dev backend's own variable and the acting identity is inside
 *    the harness namespace. A human on dev keeps the real widget.
 *  - false: the target is deployed and there is no secret. The real widget
 *    runs, which challenges headless Chromium with images, so the spec skips
 *    its reCAPTCHA-dependent steps and the runner reports them.
 *
 * Truthy in the two armed cases, which is what every spec branches on. The
 * old name is kept as an alias so the eight specs read the same.
 */
export async function armRecaptcha(page, origin) {
  if (isLoopbackOrigin(origin)) {
    await page.route(`${RECAPTCHA_SCRIPT_URL}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: recaptchaStub(LOOPBACK_RECAPTCHA_TOKEN),
      }),
    );
    return "stubbed";
  }
  const { recaptchaBypassSecret } = loadSecrets();
  if (!recaptchaBypassSecret) return false;
  await page.context().setExtraHTTPHeaders({ [RECAPTCHA_BYPASS_HEADER]: recaptchaBypassSecret });
  await page.route(`${RECAPTCHA_SCRIPT_URL}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: recaptchaStub(""),
    }),
  );
  return "bypass";
}

/** The name the specs use; see armRecaptcha. */
export const stubRecaptchaOnLoopback = armRecaptcha;

/**
 * Waits until a reCAPTCHA widget is mounted on the page, stub or real.
 *
 * `RecaptchaInvisible` loads Google's script in an effect and only then
 * renders the widget; until it has, `execute()` resolves null and the route
 * refuses the request. A person takes seconds to read the page and press the
 * button. A spec presses it in milliseconds, and the third real run of the
 * funnel lost to exactly that race. So a spec waits for the badge before it
 * presses anything reCAPTCHA-gated. `attached` rather than `visible`: the real
 * badge can sit off-screen, and being in the DOM is what says render() ran.
 */
export async function waitForRecaptchaWidget(page, { timeout = 30_000 } = {}) {
  await page
    .locator(RECAPTCHA_BADGE_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout })
    .catch((err) => {
      throw new Error(
        `no reCAPTCHA widget mounted within ${timeout}ms (${RECAPTCHA_BADGE_SELECTOR} never ` +
          "appeared). In local mode that means the stub script was not served; against " +
          `a deployed target it means Google's api.js did not load. ${err.message}`,
      );
    });
}

/**
 * Waits until React has actually hydrated the element `selector` matches.
 *
 * Every page this harness drives is server-rendered, so its markup is on
 * screen and its controls are in the DOM long before anything is listening to
 * them. A gesture in that window does not fail loudly: a press runs the
 * browser's own default form submission, and a pointer drag over a grid does
 * nothing whatsoever. Both were seen on the shared dev server on 6 September
 * 2026, and a dev server is where this bites, because it compiles a route on
 * first request while the bundle is still on its way.
 *
 * The probe is React's own bookkeeping: `precacheFiberNode` puts a
 * `__reactFiber$<key>` property on every host node it hydrates, and server
 * markup carries none. A React internal on purpose, because every public
 * signal (a load event, a network idle) answers a different question than "is
 * this control live yet", and a fixed sleep is a guess. If React ever renames
 * it, this times out saying the node never hydrated, which points at this
 * comment rather than at the product.
 *
 * `tests/e2e/events-rsvp.spec.mjs` carries its own testId-shaped copy of this,
 * written before there was a shared one. Fold it in the next time that spec is
 * run.
 */
export async function waitForHydration(page, selector, { timeout = WAIT_MS } = {}) {
  await page
    .waitForFunction(
      (css) => {
        const el = document.querySelector(css);
        return Boolean(el) && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
      },
      selector,
      { timeout, polling: 100 },
    )
    .catch((err) => {
      throw new Error(
        `${selector} was still un-hydrated ${timeout}ms after the page loaded, so a ` +
          "press or a drag on it would reach the browser's default behaviour rather " +
          `than the app's. ${err.message}`,
      );
    });
}

// ---------------------------------------------------------------------------
// Opening a browser
// ---------------------------------------------------------------------------

/**
 * Chromium, one context, one page. Shared so every spec opens the same
 * browser the same way.
 *
 * Playwright is imported dynamically because it is NOT a dependency of this
 * repo: the root package.json is what App Hosting runs `npm ci` against on the
 * critical path of every production deploy, and a browser automation library
 * plus a downloaded Chromium has no business there. A static import here would
 * break `npm test`, which imports this module through the spec files.
 */
export async function openBrowser({ viewport = DEFAULT_VIEWPORT } = {}) {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * A second identity in the same browser: a fresh context, so its cookies and
 * its Firebase Auth client state are its own.
 *
 * This is how a spec signs in as an admin and as a member at the same time
 * without signing either out. Signing out and back in would work but proves
 * something weaker, because the interesting assertions are about one identity
 * seeing what the other just did.
 */
export async function newIdentityPage(browser, { viewport = DEFAULT_VIEWPORT } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  return { context, page };
}

// ---------------------------------------------------------------------------
// Named steps, and the completion marker that proves they ran
// ---------------------------------------------------------------------------

/**
 * The step recorder every browser spec runs its work through.
 *
 * Three jobs, all of which were learned the hard way on the applicant funnel
 * and none of which any spec should reimplement:
 *
 * 1. IT RECORDS WHAT RAN. Every way a spec can decline to run (no Playwright,
 *    no fixture, a skip) still exits `node --test` at 0, which is
 *    indistinguishable from a pass. So each step records its name as it
 *    finishes and `writeMarker()` writes the list; `scripts/run-e2e.mjs`
 *    deletes the marker before the run and refuses to report success unless it
 *    comes back naming every step in `SPEC.steps`.
 * 2. IT RECORDS WHAT DID NOT. A step this mode cannot run is skipped through
 *    node:test, so the output says so, and recorded under `skipped` with its
 *    reason, never under `steps`. The runner accepts exactly the reCAPTCHA
 *    set against a deployed target and nothing else.
 * 3. IT KEEPS THE PAGE. A selector timeout says what the spec wanted and
 *    nothing about what the page showed instead. On the funnel's first real
 *    run that difference was an afternoon: the apply form never appeared, and
 *    the reason (the route had refused the reCAPTCHA token) was only in the
 *    server log. So a step that throws leaves a screenshot and the page's text
 *    under `artifactsDir`, named after the step, before the failure is
 *    reported. Best effort: a browser that has already gone must not turn one
 *    failure into two.
 */
export function createStepRecorder({ t, page, markerPath, artifactsDir, skipReasonFor }) {
  const completed = [];
  const skipped = [];
  const reasonFor = typeof skipReasonFor === "function" ? skipReasonFor : () => null;

  async function captureFailure(name) {
    try {
      mkdirSync(artifactsDir, { recursive: true });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const png = join(artifactsDir, `${slug}.png`);
      const txt = join(artifactsDir, `${slug}.txt`);
      await page.screenshot({ path: png, fullPage: true });
      const body = await page.locator("body").innerText().catch(() => "");
      writeFileSync(txt, `${page.url()}\n\n${body}\n`, "utf8");
      console.error(`[e2e-spec] step failed: "${name}". Page kept at ${png} and ${txt}.`);
    } catch (err) {
      console.error(`[e2e-spec] could not capture the failed page: ${err.message}`);
    }
  }

  return {
    /**
     * Runs one named step and records it only if it finished without throwing.
     */
    async step(name, fn) {
      const skip = reasonFor(name);
      if (skip) {
        await t.test(name, { skip }, () => {});
        skipped.push({ name, reason: skip });
        return;
      }
      let ok = false;
      await t.test(name, async (st) => {
        try {
          await fn(st);
        } catch (err) {
          await captureFailure(name);
          throw err;
        }
        ok = true;
      });
      if (ok) completed.push(name);
    },

    /**
     * Writes the marker. Call it in a `finally`, not after the last step, so a
     * failed run still says which step it got to.
     */
    writeMarker() {
      try {
        mkdirSync(dirname(markerPath), { recursive: true });
        writeFileSync(
          markerPath,
          `${JSON.stringify(
            { finishedAt: new Date().toISOString(), steps: completed, skipped },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch (err) {
        console.error(`[e2e-spec] could not write the completion marker: ${err.message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Signing in, and the one admin action several specs need
// ---------------------------------------------------------------------------

/**
 * Signs in through the REAL /login form and waits for the app to take the
 * browser off it.
 *
 * Not a minted session cookie, which the auth harness can produce without a
 * browser and which is enough for a server component. It is NOT enough here:
 * the session picker, the drop-out card and every other client island read
 * `useAuth()`, so a cookie alone leaves them in their signed-out branch and a
 * spec would be testing nothing. Driving the form leaves the browser with real
 * Firebase Auth client state AND the cookie the server wants.
 *
 * ## Why it waits, now that the form no longer loses the race itself
 *
 * An earlier version filled the two boxes and pressed as soon as `#auth-email`
 * was in the DOM. That is right against a deployed build and lost two
 * different races against a dev server, both of which were seen on
 * 6 September 2026 and both of which took whole spec runs down with them.
 * Five specs each wrote their own copy of the wait below before it was moved
 * here; this is that fix, once.
 *
 *  1. HYDRATION, which the product now answers rather than this helper. The
 *     two boxes are UNCONTROLLED (AuthEntry reads them out of the DOM when it
 *     needs them), so what is typed before React's first client render
 *     survives it; and the Sign in button carries `disabled` in the server
 *     markup until the form is live, so neither a press nor an Enter in a
 *     field can reach the browser's own submission. Both were the other way
 *     round until the hydration defects this suite found were fixed: the fill
 *     was wiped by React's first render, and a press reloaded /login with two
 *     blank fields and NO message on the form. So the fill goes in FIRST, on
 *     purpose, and the wait is for the button to lose `disabled`, which is the
 *     product's own public statement that the form is listening.
 *  2. THE ENTRANCE. AuthEntry parks the card at `translateX(112vw)` and slides
 *     it in when it clears `entering` (Google Identity Services reporting
 *     ready, or a 3.2 second fallback). A press while the card is still
 *     flying in does nothing at all: no request to identitytoolkit, no error,
 *     no navigation.
 *  3. THE READ-BACK, which is now an assertion instead of a retry loop. The
 *     two fields still holding what they were given, after the form has gone
 *     live, is the fact the other two waits are proxies for. It used to be
 *     refilled up to ten times because a controlled box could wipe it at any
 *     moment; a box that needs that today is a regression of the fix above,
 *     and this says so in one sentence rather than papering over it.
 *
 * Waiting on "the URL stopped being /login" rather than on a destination: a
 * role-pending account lands on /pending-approval and a member on the `next`
 * parameter, and which landing page a role gets is a decision no spec here has
 * a stake in. The handoff gets its own, more generous patience: it is four
 * things rather than one (Firebase mints an id token, /api/auth/session turns
 * it into a cookie, the app pushes at a route, and a dev server may still be
 * compiling that route while other specs keep it busy).
 *
 * The password is never logged, and never compared by value: the read-back
 * compares its LENGTH, so no failure message can carry it.
 *
 * @param {object} page              Playwright page.
 * @param {string} origin            The target origin.
 * @param {{email: string, password: string}} credentials
 * @param {{timeout?: number, handoffTimeout?: number}} [options]
 *   `timeout` is the patience for the first load and for every locator here.
 *   Pass a longer one on a DEV server, whose first request to a route compiles
 *   it. `handoffTimeout` is the patience for the URL leaving /login.
 */
export async function signInWithPassword(
  page,
  origin,
  { email, password },
  { timeout = WAIT_MS, handoffTimeout = SIGN_IN_HANDOFF_MS } = {},
) {
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout });
  const emailBox = page.locator("#auth-email");
  const passwordBox = page.locator("#auth-password");
  const submit = page.locator('button[type="submit"][form="auth-form"]');
  await emailBox.waitFor({ timeout });
  await submit.waitFor({ timeout });

  // 1. Fill first, deliberately racing hydration: the boxes are uncontrolled,
  //    so whether this lands before or after React arrives, the values stay.
  await emailBox.fill(email);
  await passwordBox.fill(password);

  // 2. The form is live once its submit button drops `disabled`, which is the
  //    one thing on this page that says so out loud.
  const liveDeadline = Date.now() + timeout;
  for (;;) {
    if (await submit.isEnabled()) break;
    if (Date.now() >= liveDeadline) {
      throw new Error(
        `the Sign in button on ${origin}/login still carried \`disabled\` after ${timeout}ms. ` +
          "AuthEntry disables it until React has hydrated the form, so the page never " +
          "became live and nothing could have been pressed on it anyway.",
      );
    }
    await page.waitForTimeout(100);
  }

  // 3. The card has landed, stated as cheaply as it can be observed: the
  //    submit button is fully inside the viewport rather than off to the right.
  const entranceDeadline = Date.now() + timeout;
  for (;;) {
    const width = page.viewportSize()?.width ?? 0;
    const box = await submit.boundingBox();
    if (box && width > 0 && box.x >= 0 && box.x + box.width <= width) break;
    if (Date.now() >= entranceDeadline) {
      throw new Error(
        `the sign-in card on ${origin}/login had not finished arriving after ${timeout}ms ` +
          "(the Sign in button was still outside the viewport). AuthEntry parks the card " +
          "off screen and slides it in when it clears `entering`; a press before it lands " +
          "does nothing at all, so this refuses rather than pressing into the void.",
      );
    }
    await page.waitForTimeout(100);
  }

  // 4. The read-back. One settle, one look: a live form keeps what it was
  //    given, and a form that does not is a defect rather than a retry.
  await page.waitForTimeout(FILL_SETTLE_MS);
  const keptEmail = (await emailBox.inputValue()) === email;
  const keptPassword = (await passwordBox.inputValue()).length === password.length;
  if (!keptEmail || !keptPassword) {
    throw new Error(
      `the login form on ${origin}/login did not keep the credentials it was given ` +
        `(email kept: ${keptEmail}, password kept: ${keptPassword}). Its boxes are ` +
        "meant to be uncontrolled and read from the DOM at submit; a render that empties " +
        "them is the hydration defect fixed in AuthEntry coming back, and a press now " +
        "would submit two empty fields. The password is compared by length only and is " +
        "not printed.",
    );
  }

  await submit.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: handoffTimeout,
    waitUntil: "domcontentloaded",
  });
}

/**
 * Approves one waiting applicant through the real Approvals page, as whichever
 * admin is already signed in on this page.
 *
 * Through the page rather than through the Admin SDK on purpose: a fixture
 * that flipped the document itself would prove the rest of a journey while
 * leaving the one screen a committee actually uses untested, and the harness
 * is forbidden from writing a role anyway. So the admin presses Approve, the
 * same as a person.
 *
 * The card is found by its address, which is unique per fixture account, and
 * the queue is paged through to reach it: it shows twenty at a time, newest
 * first, and a shared target can have another run's applicants sitting above
 * this one.
 *
 * ## Press Approve, and let the card leave on its own
 *
 * The queue is a ONE-SHOT read rather than a live listener: `useOneShotList`
 * in src/features/admin/adminList.tsx fetches with `getDocs` on mount and
 * re-reads when its `reload()` is called. The Approvals page now hands that
 * `reload` to each card, so a card whose Approve has landed asks for the
 * re-read itself and the row goes with it. Waiting for the detach is therefore
 * the page agreeing the write happened, and no Refresh press is needed: an
 * earlier version of this helper pressed Refresh in a retry loop because the
 * page left the approved applicant sitting there under a stuck "Approving…"
 * button, which is the defect that fix closed.
 */
export async function approvePendingApplicant(page, origin, { email }) {
  await page.goto(`${origin}/admin`, { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("approval-card").filter({ hasText: email }).first();
  await page
    .getByTestId("approval-card")
    .first()
    .waitFor({ timeout: WAIT_MS })
    .catch((err) => {
      throw new Error(
        `no approval cards appeared on ${origin}/admin within ${WAIT_MS}ms. Either ` +
          `${email} is not waiting for approval, or the signed-in account is not an ` +
          `admin and the page redirected. ${err.message}`,
      );
    });
  // Ten presses is two hundred applications, which is more than a queue ever
  // holds; the loop stops early on the card or on a queue with no more pages.
  // Load more pages rows the page has already fetched, so the next twenty
  // render on the click rather than after a round trip.
  const pageRenderMs = 5_000;
  const loadMore = page.getByRole("button", { name: "Load more" });
  for (let press = 0; press < 10; press += 1) {
    if ((await card.count()) > 0) break;
    if ((await loadMore.count()) === 0) break;
    const before = await page.getByTestId("approval-card").count();
    await loadMore.click();
    await page
      .getByTestId("approval-card")
      .nth(before)
      .waitFor({ timeout: pageRenderMs })
      .catch(() => {});
  }
  await card.waitFor({ timeout: WAIT_MS }).catch((err) => {
    throw new Error(
      `no approval card for ${email} appeared on ${origin}/admin within ${WAIT_MS}ms, ` +
        "with every page of the queue loaded. Either the account is not waiting for " +
        `approval, or somebody has already decided it. ${err.message}`,
    );
  });
  await card.getByTestId("approval-approve").click();

  await card.waitFor({ state: "detached", timeout: WAIT_MS }).catch((err) => {
    throw new Error(
      `the approval card for ${email} was still on the queue ${WAIT_MS}ms after ` +
        "Approve, so either the write did not land or the page stopped re-reading " +
        "after it. The queue is a one-shot getDocs list (useOneShotList in " +
        "src/features/admin/adminList.tsx) and the card asks it to re-read once the " +
        `approval has landed, so both failures look the same from here. ${err.message}`,
    );
  });
}
