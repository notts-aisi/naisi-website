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
import { isLoopbackOrigin } from "./env.mjs";

/** The URL the widget loads. Pinned to what `RecaptchaInvisible` appends. */
export const RECAPTCHA_SCRIPT_URL = "https://www.google.com/recaptcha/api.js";

/** What the stub hands back. Any string passes under the always-pass secret. */
export const LOOPBACK_RECAPTCHA_TOKEN = "e2e-loopback-recaptcha-token";

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
const RECAPTCHA_STUB = `
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
        setTimeout(() => widget.callback(${JSON.stringify(LOOPBACK_RECAPTCHA_TOKEN)}), 0);
      }
    },
    reset() {},
  };
})();
`;

/**
 * Serves the stub in place of Google's script for every request the page
 * makes, when and only when `origin` is loopback. Returns true when armed so
 * a spec can say which mode it ran in.
 */
export async function stubRecaptchaOnLoopback(page, origin) {
  if (!isLoopbackOrigin(origin)) return false;
  await page.route(`${RECAPTCHA_SCRIPT_URL}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: RECAPTCHA_STUB,
    }),
  );
  return true;
}

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
