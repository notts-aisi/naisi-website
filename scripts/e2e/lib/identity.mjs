/**
 * Identity Toolkit REST helpers — the only way to ask "does this password
 * actually work?", which is the whole point of the password-set assertion.
 * The Admin SDK can set a password but cannot verify one.
 */
import { loadEnv } from "./env.mjs";

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";

/**
 * Attempts an email+password sign-in against the DEV project.
 * Returns `{ ok: true }` or `{ ok: false, reason }` — never throws on a
 * rejected credential, because "this password is refused" is the expected
 * result in half the assertions here.
 */
export async function trySignInWithPassword(email, password) {
  const env = loadEnv();
  const res = await fetch(
    `${IDENTITY_TOOLKIT}/accounts:signInWithPassword?key=${encodeURIComponent(env.webApiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await res.json().catch(() => null);
  if (res.ok && body?.idToken) return { ok: true };
  return {
    ok: false,
    // Google's message, e.g. INVALID_LOGIN_CREDENTIALS / INVALID_PASSWORD.
    reason: body?.error?.message ?? `HTTP ${res.status}`,
  };
}
