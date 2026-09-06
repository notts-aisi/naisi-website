import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * A scoped way through the reCAPTCHA gate for the end-to-end harness on the
 * DEV backend, and nowhere else.
 *
 * ## Why it exists
 *
 * Against dev.naisi.uk the real reCAPTCHA widget answers headless Chromium
 * with an image challenge, which no test may solve: the gate being closed to
 * automation is the property `scripts/e2e/tests/recaptcha-gate.test.mjs`
 * asserts. So before this module the browser specs could prove the apply and
 * register legs only against a loopback server built with Google's always-pass
 * secret, and the nightly run against dev skipped them. The owner decided on
 * 6 September 2026 that a permanent local-only gap was not acceptable and
 * asked for exactly this: a bypass that a human on dev can never trip.
 *
 * ## Three conditions, all required, and only for a TOKENLESS request
 *
 *  1. `E2E_RECAPTCHA_BYPASS_SECRET` is set in this process's environment. It
 *     is set as a console environment variable on the dev backend only. It
 *     must never appear in `apphosting.yaml` (which production reads), and
 *     `tests/recaptcha-bypass.test.mjs` fails the build if it does. Without
 *     the variable this function returns false before reading anything else,
 *     so on production and on a laptop the path does not exist.
 *  2. The request carries the header `x-e2e-recaptcha-bypass` equal to that
 *     value, compared in constant time.
 *  3. The acting identity is a harness identity: an address inside the
 *     namespace `e2e-<alnum>@e2e.invalid`, the same pattern every teardown
 *     helper under `scripts/e2e` trusts and refuses outside of. For the apply
 *     routes that is the signed-in account's email; for `/api/register` it is
 *     the address being registered. `.invalid` cannot receive mail, so an
 *     account that clears this check cannot belong to a person.
 *
 * And the gate consults this ONLY when the request carries no token. A token
 * that is present is always verified with Google, bypass header or not, so a
 * human on dev keeps the real widget and a bypass secret alone changes nothing
 * for them. The harness sends no token when it holds the secret.
 */
export const RECAPTCHA_BYPASS_HEADER = "x-e2e-recaptcha-bypass";
export const RECAPTCHA_BYPASS_ENV = "E2E_RECAPTCHA_BYPASS_SECRET";

const HARNESS_EMAIL = /^e2e-[a-z0-9]+@e2e\.invalid$/;

/** True for an address inside the harness namespace and nothing else. */
export function isHarnessIdentity(email: string | null | undefined): boolean {
  return typeof email === "string" && HARNESS_EMAIL.test(email.trim().toLowerCase());
}

/**
 * Whether this tokenless request may pass the reCAPTCHA gate. See the module
 * comment for the three conditions. Logs the grant so the dev server's log
 * says every time the gate was opened this way and for whom.
 */
export function recaptchaBypassGranted(
  headers: Headers,
  email: string | null | undefined,
): boolean {
  const secret = process.env[RECAPTCHA_BYPASS_ENV];
  if (!secret) return false;
  const presented = headers.get(RECAPTCHA_BYPASS_HEADER);
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (!isHarnessIdentity(email)) return false;
  console.log(`[recaptcha] bypass granted: tokenless request from harness identity ${email}`);
  return true;
}
