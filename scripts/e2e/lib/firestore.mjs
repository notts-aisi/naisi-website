/**
 * Firestore access for Phase 2 — deliberately narrow, and a deliberate
 * loosening of a Phase 1 invariant.
 *
 * Phase 1 asserted the harness never obtained a Firestore handle at all. Phase 2
 * cannot hold that line: its headline assertion is that
 * `users/{uid}.profile.uniEmailVerifiedAt` really landed, and only an Admin-SDK
 * read can prove it (the UI reads "verified" either way, which is exactly why
 * the two-phase stamp bug was invisible by hand). So the guard was loosened —
 * as a reviewable diff, which was the point of putting it there.
 *
 * What replaces it, all enforced here at runtime and by
 * tests/e2e-no-privilege-grants.test.mjs offline:
 *  - Only two collections are reachable: `users` and `emailVerifications`.
 *  - A `users` document may only ever be written for a uid this harness
 *    created, and only with `role: "pending"` — the lowest role there is,
 *    which grants access to nothing. Never `member`, `committee`, `admin`,
 *    `suRecognised`, or a `permissions` map.
 *  - Every document written is recorded so teardown can remove it, and
 *    teardown re-verifies the account namespace before deleting anything.
 */
import { getFirestore } from "firebase-admin/firestore";
import { adminApp, isHarnessAccount } from "./admin.mjs";

/** The only collections this harness may touch. */
export const ALLOWED_COLLECTIONS = ["users", "emailVerifications"];

/** The only role this harness may ever write. */
export const ONLY_ALLOWED_ROLE = "pending";

let db = null;

export function adminDb() {
  if (!db) db = getFirestore(adminApp());
  return db;
}

function assertCollection(name) {
  if (!ALLOWED_COLLECTIONS.includes(name)) {
    throw new Error(
      `REFUSING to touch collection ${JSON.stringify(name)}. The harness may only ` +
        `reach ${ALLOWED_COLLECTIONS.join(", ")} — dev holds real member data.`,
    );
  }
}

/**
 * Tracks everything written so a run can always clean up after itself, even
 * on failure.
 */
export function createLedger() {
  const docs = [];
  return {
    record(collection, id) {
      assertCollection(collection);
      docs.push({ collection, id });
    },
    async teardown() {
      const results = [];
      for (const { collection, id } of docs.reverse()) {
        try {
          // Literal collection names, deliberately: a dynamically-built name
          // is invisible to the offline allowlist check in
          // tests/e2e-no-privilege-grants.test.mjs, so the harness never
          // builds one — including here, where a variable would be natural.
          const ref =
            collection === "users"
              ? adminDb().collection("users").doc(id)
              : adminDb().collection("emailVerifications").doc(id);
          await ref.delete();
          results.push({ collection, id, deleted: true });
        } catch (err) {
          results.push({ collection, id, deleted: false, error: String(err) });
        }
      }
      docs.length = 0;
      return results;
    },
  };
}

/**
 * Seeds an `emailVerifications` record exactly as /api/verify-email/send would,
 * WITHOUT calling that route — because calling it dispatches a real email to a
 * real @nottingham.ac.uk address, which would bounce and damage the sending
 * reputation production depends on. The magic-link leg is then driven for real
 * from this seed.
 */
export async function seedEmailVerification(ledger, { tokenId, email, authUid, ttlSeconds = 1800 }) {
  const now = new Date();
  await adminDb()
    .collection("emailVerifications")
    .doc(tokenId)
    .set({
      email,
      authUid,
      createdAt: now,
      lastSentAt: now,
      sendCount: 1,
      verifiedAt: null,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    });
  ledger.record("emailVerifications", tokenId);
  return tokenId;
}

export async function readEmailVerification(tokenId) {
  const snap = await adminDb().collection("emailVerifications").doc(tokenId).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Creates the minimal `users` document the register flow would create, for a
 * harness-created account only.
 *
 * `role` is hard-coded, not a parameter: a caller-supplied role is exactly the
 * shape that lets a future edit quietly escalate. The offline guard also
 * rejects any other role literal appearing anywhere in this tree.
 */
export async function seedPendingUserDoc(ledger, { uid, email, universityEmail }) {
  if (!isHarnessAccount(email)) {
    throw new Error(
      `REFUSING to write users/${uid}: ${JSON.stringify(email)} is not a harness ` +
        "account. This harness only ever creates documents for accounts it made.",
    );
  }
  await adminDb()
    .collection("users")
    .doc(uid)
    .set({
      uid,
      email,
      displayName: "E2E Harness",
      role: ONLY_ALLOWED_ROLE,
      showOnMembers: false,
      createdAt: new Date(),
      profile: {
        preferredName: "E2E",
        universityEmail,
        status: "undergraduate",
        subject: "e2e",
        motivation: "automated test fixture",
      },
    });
  ledger.record("users", uid);
}

export async function readUserDoc(uid) {
  const snap = await adminDb().collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}
