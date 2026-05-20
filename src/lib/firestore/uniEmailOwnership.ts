import "server-only";
import type { Firestore } from "firebase-admin/firestore";

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
