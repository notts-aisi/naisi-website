/**
 * Obtains a real `__session` cookie for a harness account, without a browser.
 *
 * custom token (Admin SDK) → Identity Toolkit REST → POST /api/auth/session
 *
 * Why this is in Phase 1 at all: the assertion this harness exists for — the
 * PR #209 regression guard on /api/verify-email/send — is only meaningful with
 * a valid session. That route checks `getCurrentUser()` BEFORE it validates
 * the email address, so an unauthenticated probe gets 401 and a test asserting
 * "non-Nottingham address is rejected" would pass without ever reaching the
 * gate it claims to protect. See tests/uni-email-gate.test.mjs, which asserts
 * the 401 and the 400 separately for exactly this reason.
 *
 * KNOWN GAP, by design: an ID token minted from a custom token carries
 * `firebase.sign_in_provider === "custom"`, so the Google-orphan branch in
 * src/app/api/auth/session/route.ts (recordGoogleRegistrationCreated, gated on
 * "google.com") never runs under this harness. Google sign-in is not
 * automatable — see README.
 */
import { adminAuth, createHarnessUser, deleteHarnessUser } from "./admin.mjs";
import { loadEnv } from "./env.mjs";

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";

async function exchangeCustomToken(customToken, webApiKey) {
  const res = await fetch(
    `${IDENTITY_TOOLKIT}/accounts:signInWithCustomToken?key=${encodeURIComponent(webApiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.idToken) {
    throw new Error(
      `Identity Toolkit exchange failed (${res.status}): ${JSON.stringify(body)}\n` +
        `Check NEXT_PUBLIC_FIREBASE_API_KEY in .env.e2e.local is the DEV project's web API key.`,
    );
  }
  return body.idToken;
}

/**
 * Extracts the __session cookie from a Set-Cookie list. Uses getSetCookie()
 * because a plain get("set-cookie") folds multiple cookies into one string
 * and mangles them.
 */
function readSessionCookie(res) {
  const all = res.headers.getSetCookie?.() ?? [];
  for (const raw of all) {
    const [pair] = raw.split(";");
    if (pair.startsWith("__session=")) return pair;
  }
  return null;
}

/**
 * Creates a throwaway account, signs it in, and returns its session cookie
 * plus a `dispose()` that removes the Auth user again.
 *
 * The resulting identity has NO Firestore document, so it has no role at all
 * and can reach nothing role-gated. That is deliberate: the routes under test
 * need only "is somebody signed in", and anything more would be a privilege
 * this harness has no business creating.
 */
export async function withHarnessSession(id, options = {}) {
  const env = loadEnv();
  const { uid, email } = await createHarnessUser(id, options);
  let cookie = null;
  try {
    const customToken = await adminAuth().createCustomToken(uid);
    const idToken = await exchangeCustomToken(customToken, env.webApiKey);
    const res = await fetch(`${env.origin}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      throw new Error(`POST /api/auth/session failed (${res.status})`);
    }
    cookie = readSessionCookie(res);
    if (!cookie) {
      throw new Error("POST /api/auth/session returned no __session cookie.");
    }
  } catch (err) {
    await deleteHarnessUser(uid).catch(() => {});
    throw err;
  }
  return {
    uid,
    email,
    cookie,
    dispose: () => deleteHarnessUser(uid),
  };
}

/**
 * Exchanges an ID token for a fresh `__session` cookie — the same call the
 * client makes. Used to re-establish a session after a password change
 * revokes the previous one.
 */
export async function sessionCookieFromIdToken(idToken) {
  const env = loadEnv();
  const res = await fetch(`${env.origin}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(`POST /api/auth/session failed (${res.status})`);
  const cookie = readSessionCookie(res);
  if (!cookie) throw new Error("POST /api/auth/session returned no __session cookie.");
  return cookie;
}

/** fetch() against the target with the harness session attached. */
export function authedFetch(cookie, path, init = {}) {
  const env = loadEnv();
  return fetch(`${env.origin}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
}

/** fetch() against the target with no credentials. */
export function anonFetch(path, init = {}) {
  const env = loadEnv();
  return fetch(`${env.origin}${path}`, init);
}
