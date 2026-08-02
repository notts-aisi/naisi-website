import "server-only";
import type { Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * A university email address belongs to at most one NAISI account. This
 * helper answers "does another account already own this uni email?" and is
 * the shared gate behind:
 *  - /api/verify-email/send  — branches to the "you already have an account"
 *    email instead of a verification email.
 *  - confirmUniEmailVerification — rejects at click time, catching the race
 *    where two people request verification of the same address concurrently.
 */

export type UniEmailOwner = {
  uid: string;
  /** The Google account email the existing account signs in with. */
  googleEmail: string;
  displayName: string;
};

/**
 * Find the account (if any) that already has `email` as a VERIFIED
 * university email, excluding `excludeUid`. Returns null if the address is
 * free to claim.
 *
 * Implementation note: a full `users` scan with a case-insensitive compare,
 * rather than `where("profile.universityEmail", "==", ...)`. Stored uni
 * emails are trimmed but not lowercased, so an equality query would miss a
 * mixed-case stored value. The `users` collection is small (NAISI scale)
 * and verification is a rare, registration-time operation, so the scan is
 * cheap and dodges a case-sensitivity bug.
 */
export async function findVerifiedUniEmailOwner(
  db: Firestore,
  email: string,
  excludeUid: string,
): Promise<UniEmailOwner | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;

  const snap = await db.collection("users").get();
  for (const doc of snap.docs) {
    if (doc.id === excludeUid) continue;
    const data = doc.data();
    const profile = (data.profile ?? {}) as Record<string, unknown>;
    if (!profile.uniEmailVerifiedAt) continue;
    const stored = profile.universityEmail;
    if (typeof stored !== "string") continue;
    if (stored.trim().toLowerCase() !== target) continue;
    return {
      uid: doc.id,
      googleEmail: typeof data.email === "string" ? data.email : "",
      displayName: typeof data.displayName === "string" ? data.displayName : "",
    };
  }
  return null;
}

/**
 * Stamp `users/{uid}.profile.uniEmailVerifiedAt` from the SERVER-SIDE proof of
 * verification, if (and only if) that proof exists. This is the authoritative
 * replacement for the old client-written stamp.
 *
 * `emailVerifications` is server-only (`allow write: if false` in the rules), so
 * a doc with `verifiedAt` set is an unforgeable record that the user actually
 * clicked the magic link for that address. The user-doc field, by contrast, was
 * previously written by the client at registration time (the server couldn't
 * stamp it then — the user doc didn't exist yet), which let a caller forge
 * "verified" for an address they don't own. Registration now creates the user
 * doc first, then calls this (via `/api/verify-email/reconcile`) to stamp the
 * flag server-side; the client no longer writes it.
 *
 * Idempotent and safe to call repeatedly: it no-ops if the flag is already set,
 * if there's no matching verified token, or if the address's uniqueness can't be
 * re-confirmed. The verified-token match already implies uniqueness was checked
 * at confirm time (`confirmUniEmailVerification` rejects a duplicate before
 * setting `verifiedAt`), but we re-run the owner check to also lose the narrow
 * race where a concurrent registration stamped the same address first.
 */
export async function stampVerifiedUniEmailForUser(
  db: Firestore,
  uid: string,
): Promise<{ stamped: boolean }> {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return { stamped: false };

  const profile = (userSnap.data()?.profile ?? {}) as Record<string, unknown>;
  // Already stamped (e.g. the /profile re-verify path stamped it directly) —
  // nothing to do.
  if (profile.uniEmailVerifiedAt) return { stamped: false };

  const uniEmail =
    (profile.universityEmail as string | undefined)?.trim().toLowerCase() ?? "";
  if (!uniEmail) return { stamped: false };

  // Find a verified, uni-email (not login-email) token for THIS user and THIS
  // address. Query by authUid only (a single-field auto-index) and filter the
  // rest in code, so no composite index is required.
  const snap = await db
    .collection("emailVerifications")
    .where("authUid", "==", uid)
    .get();

  let verifiedAt: Timestamp | null = null;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.kind === "login-email") continue;
    if (!data.verifiedAt) continue;
    const docEmail = (data.email as string | undefined)?.trim().toLowerCase() ?? "";
    if (docEmail !== uniEmail) continue;
    verifiedAt = data.verifiedAt as Timestamp;
    break;
  }
  if (!verifiedAt) return { stamped: false };

  // Re-confirm no OTHER account already owns this verified address before we
  // stamp — defence in depth against the concurrent-registration race.
  const otherOwner = await findVerifiedUniEmailOwner(db, uniEmail, uid);
  if (otherOwner) return { stamped: false };

  await userRef.update({ "profile.uniEmailVerifiedAt": verifiedAt });
  return { stamped: true };
}
