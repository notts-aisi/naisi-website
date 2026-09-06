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
 * The one namespace allowed to exercise Storage rules — see getTestEnv below.
 * It is also the only namespace that uploads `storage.rules` to the emulator,
 * because that upload is global rather than per-project.
 */
const STORAGE_NAMESPACE = "test";

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
 * ONE EXCEPTION, and it will cost you an hour if you hit it blind: any test
 * exercising STORAGE rules must use the namespace "test", so its project id
 * matches the `--project naisi-rules-test` that `emulators:exec` starts with.
 * `storage.rules` resolves its `firestore.get()` lookups against the project
 * the EMULATOR was started with, not the one this client connects as — so with
 * a mismatched namespace every role lookup silently returns nothing and every
 * "should be allowed" test fails with storage/unauthorized while every "should
 * be denied" test passes. That asymmetry is the tell.
 *
 * @param namespace unique per test file, e.g. "candidate-findings"; must be
 *                  "test" for any file touching Storage rules
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
    // Storage rules are loaded too, because `storage.rules` reaches ACROSS
    // services — every gate in it calls `firestore.get(/documents/users/...)`
    // to read the actor's role. Testing it therefore needs both emulators
    // running with both rulesets, or the lookups silently fail.
    //
    // But ONLY the storage namespace may load them. Firestore rules upload
    // per PROJECT, so each namespace's copy is private; Storage rules do not —
    // `initializeTestEnvironment` PUTs them to /internal/setRules with no
    // project id, replacing the emulator's ONE global ruleset. The emulator
    // serves that by dropping the live ruleset, building a fresh manager and
    // reloading asynchronously, and any storage request landing inside that
    // window is denied outright ("Permission denied because no Storage ruleset
    // is currently loaded") with the same storage/unauthorized code a real rule
    // denial produces. Every non-storage file pushing the identical ruleset at
    // startup was therefore pure collateral damage: the only requests those
    // reloads could ever hit were storage.test.mjs's own uploads. It read as a
    // flake because only `assertSucceeds` can be broken by a stray deny — a
    // deny window cannot fail a test that expects a deny — so a different
    // "should be allowed" case died each run and every "should be denied" one
    // stayed green. The emulator already boots with this exact file via
    // firebase.json's `storage.rules`, so nobody else needs to push it.
    storage: {
      ...(namespace === STORAGE_NAMESPACE
        ? { rules: readFileSync(join(REPO_ROOT, "storage.rules"), "utf8") }
        : {}),
      host: "127.0.0.1",
      port: 9199,
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

/**
 * Firestore as a signed-in user with the given uid.
 *
 * The fake token carries an `email` claim matching what `seedUser` writes,
 * because `users` create now pins `request.resource.data.email` to
 * `request.auth.token.email` — the field is treated downstream as a PROVEN
 * inbox (subscription sync confirms rows from it without a click), so it must
 * be the address Firebase Auth actually verified. A token with no email would
 * make every create test pass or fail for the wrong reason.
 *
 * Pass `email` explicitly to test a mismatch.
 */
export async function asUser(uid, { email = `${uid}@example.com` } = {}) {
  const env = await getTestEnv();
  return env.authenticatedContext(uid, { email }).firestore();
}

/** Firestore as a signed-out visitor. */
export async function asAnon() {
  const env = await getTestEnv();
  return env.unauthenticatedContext().firestore();
}

/** Cloud Storage as a signed-in user. */
export async function storageAsUser(uid) {
  const env = await getTestEnv();
  return env.authenticatedContext(uid).storage();
}

/** Cloud Storage as a signed-out visitor. */
export async function storageAsAnon() {
  const env = await getTestEnv();
  return env.unauthenticatedContext().storage();
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

/**
 * Convenience: create a users/{uid} doc with a given role, rules disabled.
 *
 * Reads the document back before returning. Storage rules resolve roles via a
 * cross-service `firestore.get()`, and a test that uploads immediately after
 * seeding was observed failing roughly once in fourteen runs — consistent with
 * the write not yet being visible to that lookup. The read-back costs
 * milliseconds and removes the race from the test's control flow.
 *
 * That once-in-fourteen flake was almost certainly the global-ruleset reload
 * documented in getTestEnv, not this lookup: the read-back is harmless and
 * stays, but check the emulator log for "no Storage ruleset is currently
 * loaded" before suspecting seeding again.
 */
export async function seedUser(uid, data = {}) {
  await seed(async (db) => {
    const ref = db.collection("users").doc(uid);
    await ref.set({
      uid,
      email: `${uid}@example.com`,
      displayName: uid,
      role: "member",
      createdAt: new Date(),
      ...data,
    });
    await ref.get();
  });
}

export async function clearData() {
  const env = await getTestEnv();
  await env.clearFirestore();
}
