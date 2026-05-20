import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { verifyToken } from "@/lib/signedTokens";
import { findVerifiedUniEmailOwner } from "@/lib/firestore/uniEmailOwnership";

export type ConfirmUniEmailResult =
  | { ok: true; email: string }
  | { ok: false; error: string; status: number };

/**
 * Shared confirmation logic for the uni-email magic link. Called both by the
 * `/api/verify-email/confirm` route (client-side POST path, used by other
 * consumers) and directly from the `/verify-email/[tokenId]` server component
 * (no internal HTTP roundtrip — dodges the Cloud Run revision-URL auth
 * gotcha where the page's `host` header is the internal revision hostname,
 * not the public one, and internal URLs require IAM auth we don't have).
 */
export async function confirmUniEmailVerification(
  db: Firestore,
  signed: string | undefined | null,
): Promise<ConfirmUniEmailResult> {
  if (!signed) {
    return { ok: false, error: "Missing token", status: 400 };
  }

  const payload = verifyToken(signed, "verify-uni-email");
  if (!payload || payload.s !== "verify-uni-email") {
    return { ok: false, error: "Invalid or expired link", status: 400 };
  }

  const ref = db.collection("emailVerifications").doc(payload.v);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn("[confirmUniEmail] Firestore doc missing", { tokenId: payload.v });
    return { ok: false, error: "Verification request not found", status: 404 };
  }

  const data = snap.data()!;
  const expiresAt = data.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) {
    console.warn("[confirmUniEmail] Firestore doc expiresAt in past", {
      tokenId: payload.v,
      expiresAt: expiresAt.toDate().toISOString(),
      now: new Date().toISOString(),
    });
    return { ok: false, error: "Link has expired", status: 410 };
  }

  const authUid = data.authUid as string | undefined;
  const verifiedEmail = (data.email as string | undefined)?.trim().toLowerCase() ?? "";

  // A uni email belongs to at most one NAISI account. The send route
  // already branches duplicates to the "already registered" email, but
  // re-check here to catch the race where two people requested verification
  // of the same address before either confirmed. Reject the second click.
  // Excludes authUid so an idempotent re-click of an already-verified link
  // does not flag the caller's own row.
  if (verifiedEmail && authUid) {
    const owner = await findVerifiedUniEmailOwner(db, verifiedEmail, authUid);
    if (owner) {
      console.warn("[confirmUniEmail] uni email already verified elsewhere", {
        tokenId: payload.v,
        verifiedEmail,
        ownerUid: owner.uid,
      });
      return {
        ok: false,
        error:
          "This university email is already linked to another NAISI account. Sign in with that account, or email accounts@naisi.uk if you have lost access to it.",
        status: 409,
      };
    }
  }

  if (!data.verifiedAt) {
    const now = Timestamp.now();
    const batch = db.batch();
    batch.update(ref, { verifiedAt: now });

    // Also stamp the user doc so `profile.uniEmailVerifiedAt` reflects the
    // current verification state without needing the user to submit a form.
    // Only stamp if the user's current `profile.universityEmail` still matches
    // the address that was just verified — if they changed it in the meantime,
    // the old verification doesn't apply to the new address and we'd be
    // falsely marking them verified.
    if (authUid && verifiedEmail) {
      const userRef = db.collection("users").doc(authUid);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        const profile = userSnap.data()?.profile as Record<string, unknown> | undefined;
        const currentUniEmail =
          (profile?.universityEmail as string | undefined)?.trim().toLowerCase() ?? "";
        if (currentUniEmail === verifiedEmail) {
          batch.update(userRef, { "profile.uniEmailVerifiedAt": now });
        } else {
          console.log(
            "[confirmUniEmail] user's current uni email differs from verified address — skipping user-doc stamp",
            { authUid, currentUniEmail, verifiedEmail },
          );
        }
      }
    }

    await batch.commit();
  }

  console.log("[confirmUniEmail] verified", { tokenId: payload.v, email: data.email });
  return { ok: true, email: (data.email as string) ?? "" };
}
