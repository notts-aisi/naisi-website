/**
 * Firebase Admin SDK, dev project only (loadEnv() enforces that before this
 * module can obtain credentials).
 *
 * Scope discipline, deliberately narrow:
 * - This harness creates Auth users. It writes NO Firestore document, so it
 *   can grant no role, no permission and no admin-set flag. The only
 *   Firestore call here is `deleteHarnessUserDoc`, a DELETE of the users
 *   document belonging to an account this harness made, behind the same
 *   namespace check as the Auth deletion. The offline guard at
 *   tests/e2e-no-privilege-grants.test.mjs enforces both as build-time facts
 *   rather than conventions.
 * - Teardown refuses to delete any account whose email does not match this
 *   harness's own namespace. dev Firestore holds real people's data; a
 *   cleanup helper that trusted a uid argument could wipe a real test account
 *   on a bad day.
 */
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./env.mjs";

/**
 * The service account whose identity is borrowed to SIGN custom tokens.
 * Signing is the one operation Application Default Credentials cannot do
 * alone: a user credential has no private key, so firebase-admin asks IAM to
 * sign on this account's behalf. Hard-coded to dev, like every other
 * identifier here.
 */
const SIGNING_SERVICE_ACCOUNT =
  "firebase-adminsdk-fbsvc@naisi-website-dev.iam.gserviceaccount.com";

/**
 * Namespace for every account this harness creates. `.invalid` is reserved by
 * RFC 2606 and can never receive mail, so a stray send can't reach a real
 * inbox or generate a bounce against the domain prod's deliverability
 * depends on.
 */
export const E2E_EMAIL_DOMAIN = "e2e.invalid";
const E2E_EMAIL_PATTERN = /^e2e-[a-z0-9]+@e2e\.invalid$/;

export function isHarnessAccount(email) {
  return typeof email === "string" && E2E_EMAIL_PATTERN.test(email);
}

export function harnessEmail(id) {
  const email = `e2e-${id}@${E2E_EMAIL_DOMAIN}`;
  // Belt and braces: if the id ever contains something the pattern rejects,
  // fail here rather than creating an account teardown cannot clean up.
  if (!isHarnessAccount(email)) {
    throw new Error(`Constructed a non-namespaced harness email: ${email}`);
  }
  return email;
}

let app = null;

export function adminApp() {
  if (app) return app;
  const env = loadEnv();
  const existing = getApps().find((a) => a.name === "e2e");
  app =
    existing ??
    initializeApp(
      {
        // Application Default Credentials — deliberately NOT a downloaded
        // service-account key. A key file is a permanent credential sitting in
        // plaintext that any process running as this user can read; ADC is a
        // revocable token (`gcloud auth application-default revoke`), which
        // makes "log out and the laptop can reach nothing" actually true.
        // This also matches how the deployed app authenticates: see the
        // applicationDefault() fallback in src/lib/firebase/admin.ts.
        credential: applicationDefault(),
        // Explicit, and asserted against the literal dev id in env.mjs. The
        // ADC file's own quota_project may point elsewhere; the project a
        // resource lands in is decided HERE.
        projectId: env.projectId,
        serviceAccountId: SIGNING_SERVICE_ACCOUNT,
      },
      "e2e",
    );
  return app;
}

export function adminAuth() {
  return getAuth(adminApp());
}

/**
 * Creates a bare Auth user with no Firestore document — so it has no role at
 * all (not even `pending`), holds no profile data, and is invisible to every
 * role-gated surface. That is the least-privileged identity that can still
 * satisfy the `getCurrentUser()` check on the routes under test.
 */
export async function createHarnessUser(id, { emailVerified = false, password } = {}) {
  const email = harnessEmail(id);
  // Any password must be set AT CREATION: a later updateUser({password}) bumps
  // validSince and revokes every session cookie already minted for the user.
  const user = await adminAuth().createUser({
    email,
    emailVerified,
    ...(password ? { password } : {}),
  });
  return { uid: user.uid, email };
}

/**
 * Deletes an account created by this harness. Refuses anything outside the
 * namespace — including a uid that resolves to a real dev account.
 */
export async function deleteHarnessUser(uid) {
  const auth = adminAuth();
  let record;
  try {
    record = await auth.getUser(uid);
  } catch {
    return { deleted: false, reason: "not-found" };
  }
  if (!isHarnessAccount(record.email)) {
    throw new Error(
      `REFUSING to delete ${uid}: its email is not a harness account. ` +
        `Teardown only ever removes accounts this harness created.`,
    );
  }
  await auth.deleteUser(uid);
  return { deleted: true };
}

/**
 * Deletes the `users/{uid}` document belonging to an account this harness
 * created, under the SAME namespace check `deleteHarnessUser` applies.
 *
 * It exists because the check has to happen before the delete, not after. The
 * funnel teardown used to remove the document by the uid its state file named
 * and only then call `deleteHarnessUser`, which would refuse a real member's
 * uid: by then the document was already gone, and the refusal was a rejection
 * nobody was catching for a reason. Resolving the account here and reading the
 * address off the Auth record means a state file that pairs a harness email
 * with somebody else's uid deletes nothing.
 *
 * An account that no longer exists is left alone rather than guessed at: with
 * no record there is no address to check, and the funnel's manifest counts
 * `users` documents so a stranded one is reported instead of silently removed.
 */
export async function deleteHarnessUserDoc(uid) {
  const auth = adminAuth();
  let record;
  try {
    record = await auth.getUser(uid);
  } catch {
    return { deleted: false, reason: "not-found" };
  }
  if (!isHarnessAccount(record.email)) {
    throw new Error(
      `REFUSING to delete users/${uid}: its email is not a harness account. ` +
        "Only documents belonging to accounts this harness created may be removed.",
    );
  }
  await getFirestore(adminApp()).collection("users").doc(record.uid).delete();
  return { deleted: true };
}

/**
 * Looks up an account BY EMAIL, for accounts the local server's /api/register
 * route created (the route owns the uid, so unlike createHarnessUser the
 * harness never saw it). Namespace-guarded twice: the argument must be a
 * harness address, and the resolved record is re-checked before the uid is
 * handed to anything that might delete it.
 */
export async function harnessUserByEmail(email) {
  if (!isHarnessAccount(email)) {
    throw new Error(
      `REFUSING to look up ${JSON.stringify(email)}: not a harness account. ` +
        "This helper exists to clean up after /api/register tests, nothing else.",
    );
  }
  let record;
  try {
    record = await adminAuth().getUserByEmail(email);
  } catch {
    return null;
  }
  if (!isHarnessAccount(record.email)) return null;
  return { uid: record.uid, email: record.email };
}

/**
 * Sweeps up harness accounts left behind by a crashed run. Only ever touches
 * the namespace; paginates so it works regardless of dev's user count.
 */
export async function sweepHarnessUsers({ olderThanMs = 0 } = {}) {
  const auth = adminAuth();
  const cutoff = Date.now() - olderThanMs;
  let pageToken;
  let removed = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    const stale = page.users.filter(
      (u) =>
        isHarnessAccount(u.email) &&
        new Date(u.metadata.creationTime).getTime() <= cutoff,
    );
    for (const u of stale) {
      await auth.deleteUser(u.uid);
      removed += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return removed;
}
