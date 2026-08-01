/**
 * Firebase Admin SDK, dev project only (loadEnv() enforces that before this
 * module can obtain credentials).
 *
 * Scope discipline, deliberately narrow:
 * - This harness creates Auth users and nothing else. It writes NO Firestore
 *   documents, so it cannot grant a role, a permission, or `suRecognised` —
 *   there is no code path here that writes to `users/`. The offline guard at
 *   tests/e2e-no-privilege-grants.test.mjs enforces that as a build-time fact
 *   rather than a convention.
 * - Teardown refuses to delete any account whose email does not match this
 *   harness's own namespace. dev Firestore holds real people's data; a
 *   cleanup helper that trusted a uid argument could wipe a real test account
 *   on a bad day.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { loadEnv } from "./env.mjs";

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
        credential: cert({
          projectId: env.projectId,
          clientEmail: env.clientEmail,
          privateKey: env.privateKey,
        }),
        projectId: env.projectId,
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
export async function createHarnessUser(id) {
  const email = harnessEmail(id);
  const user = await adminAuth().createUser({ email, emailVerified: false });
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
