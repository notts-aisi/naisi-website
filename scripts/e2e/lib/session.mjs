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
import {
  adminAuth,
  createHarnessUser,
  deleteHarnessUser,
  isHarnessAccount,
} from "./admin.mjs";
import { loadEnv } from "./env.mjs";
import { fetchOrExplain } from "./net.mjs";

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";

async function exchangeCustomToken(customToken, webApiKey) {
  const res = await fetchOrExplain(
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
    cookie = await mintSessionCookie(uid, env.origin);
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
 * The whole chain for an account that exists: custom token, Identity Toolkit
 * exchange, POST /api/auth/session on `origin`, cookie out. `origin` is the
 * server the cookie is minted THROUGH; a session cookie is a Firebase Auth
 * artefact for the project and is valid on any server verifying against it,
 * which is what lets the persona battery mint on its own loopback origin.
 * Callers guard the namespace themselves: this takes a uid and asks nothing.
 */
export async function mintSessionCookie(uid, origin) {
  const env = loadEnv();
  const customToken = await adminAuth().createCustomToken(uid);
  const idToken = await exchangeCustomToken(customToken, env.webApiKey);
  const res = await fetchOrExplain(`${origin}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(`POST /api/auth/session failed (${res.status})`);
  const cookie = readSessionCookie(res);
  if (!cookie) throw new Error("POST /api/auth/session returned no __session cookie.");
  return cookie;
}

/**
 * Exchanges an ID token for a fresh `__session` cookie — the same call the
 * client makes. Used to re-establish a session after a password change
 * revokes the previous one.
 */
export async function sessionCookieFromIdToken(idToken) {
  const env = loadEnv();
  const res = await fetchOrExplain(`${env.origin}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(`POST /api/auth/session failed (${res.status})`);
  const cookie = readSessionCookie(res);
  if (!cookie) throw new Error("POST /api/auth/session returned no __session cookie.");
  return cookie;
}

/**
 * Session cookie for an account that ALREADY exists — the local /api/register
 * batteries need this, because there the ROUTE creates the account and the
 * harness only ever learns its uid afterwards. Same custom-token → Identity
 * Toolkit → /api/auth/session chain as withHarnessSession, without the create.
 */
export async function sessionCookieForUid(uid) {
  const env = loadEnv();
  // Namespace-guarded like every other uid-taking helper here. Without this it
  // is a "mint me a working session for any uid" primitive, and dev holds real
  // members' accounts — one mistaken uid would be a live session as a real
  // person, against real PII.
  const record = await adminAuth().getUser(uid);
  if (!isHarnessAccount(record.email)) {
    throw new Error(
      `REFUSING to mint a session for ${uid}: its email is not a harness account. ` +
        "This helper exists for accounts /api/register created during a local run.",
    );
  }
  const customToken = await adminAuth().createCustomToken(uid);
  const idToken = await exchangeCustomToken(customToken, env.webApiKey);
  return sessionCookieFromIdToken(idToken);
}

/** fetch() against the target with the harness session attached. */
export function authedFetch(cookie, path, init = {}) {
  const env = loadEnv();
  // NO retry: a battery asserts on this response, and a POST the server had
  // processed before the socket dropped must not be sent twice. The wrapper
  // still names the socket error's code instead of undici's bare message.
  return fetchOrExplain(`${env.origin}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  }, { retries: 0 });
}

/** fetch() against the target with no credentials. */
export function anonFetch(path, init = {}) {
  const env = loadEnv();
  return fetchOrExplain(`${env.origin}${path}`, init, { retries: 0 });
}
