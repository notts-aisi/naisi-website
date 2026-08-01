/**
 * Firestore rules test harness.
 *
 * Runs entirely against the local Firestore emulator on a throwaway project id
 * — it never touches dev or production, needs no credentials, and works
 * offline. That is the whole point: `firestore.rules` is the layer that
 * *contained* the PR #209 damage, and until now every rule change has been
 * unverifiable except by hand in the console.
 *
 * THE AUTH EMULATOR IS PERMANENTLY OUT OF SCOPE. `FIREBASE_AUTH_EMULATOR_HOST`
 * makes firebase-admin verify JWTs with `algorithms: ['none']`, and
 * `/api/auth/session` calls `verifyIdToken` on an attacker-supplied request
 * body field — one stray env var would mint a session for any uid, including
 * an admin's. `@firebase/rules-unit-testing` fakes auth tokens in-process
 * without any emulator, which is why this is safe.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export { assertFails, assertSucceeds };

let testEnv;

/**
 * `node --test` runs each test FILE in its own parallel process, and every
 * file here shares one emulator. With a shared project id, one file's
 * `clearFirestore()` in `afterEach` wipes another file's fixtures mid-test —
 * observed as a suite that passed, then failed one test, then passed again.
 *
 * So each file gets its own project id, which the emulator keeps in a separate
 * namespace. Isolation is then real rather than a function of timing, and
 * adding a third test file cannot reintroduce the race.
 *
 * @param namespace unique per test file, e.g. "candidate-findings"
 */
export async function getTestEnv(namespace) {
  if (testEnv) return testEnv;
  if (!namespace) {
    throw new Error(
      "getTestEnv(namespace) requires a namespace unique to this test file — " +
        "sharing one across files lets parallel runs clear each other's data.",
    );
  }
  testEnv = await initializeTestEnvironment({
    projectId: `naisi-rules-${namespace}`,
    firestore: {
      rules: readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
  return testEnv;
}

export async function cleanup() {
  if (testEnv) {
    await testEnv.cleanup();
    testEnv = undefined;
  }
}

/** Firestore as a signed-in user with the given uid (no custom claims). */
export async function asUser(uid) {
  const env = await getTestEnv();
  return env.authenticatedContext(uid).firestore();
}

/** Firestore as a signed-out visitor. */
export async function asAnon() {
  const env = await getTestEnv();
  return env.unauthenticatedContext().firestore();
}

/**
 * Seeds documents with rules DISABLED, for fixtures the rules would otherwise
 * reject (roles, verified stamps, other people's data).
 */
export async function seed(fn) {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.firestore());
  });
}

/** Convenience: create a users/{uid} doc with a given role, rules disabled. */
export async function seedUser(uid, data = {}) {
  await seed(async (db) => {
    await db
      .collection("users")
      .doc(uid)
      .set({
        uid,
        email: `${uid}@example.com`,
        displayName: uid,
        role: "member",
        createdAt: new Date(),
        ...data,
      });
  });
}

export async function clearData() {
  const env = await getTestEnv();
  await env.clearFirestore();
}
