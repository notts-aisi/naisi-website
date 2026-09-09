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
 *
 * OWNERSHIP BINDING (`callerUid`). Confirming a uni-email link marks the
 * `authUid` recorded on the token as the verified owner of that address — it
 * stamps `users/{authUid}.profile.uniEmailVerifiedAt` and closes the address
 * against every other account (`findVerifiedUniEmailOwner`). The address the
 * link was mailed to is chosen by the caller of `/api/verify-email/send`, and
 * the token binds to THAT caller's uid, not to whoever ends up clicking. So a
 * confirmation completed by anyone but the token's own account would let a
 * caller start ownership proof for a stranger's university address, mail the
 * stranger a genuine NAISI link addressed to them by name, and — on their
 * click — squat that address on the caller's account (the real owner is then
 * refused with "already linked to another account"). Uni-email verification is
 * an attribute proof on an ALREADY-SIGNED-IN account (unlike the login-email
 * magic link, which mints a session and is cross-device by design), so the
 * confirming request must be authenticated as `authUid`. `callerUid` is the uid
 * the confirming request resolves (`null` when signed out); a mismatch is
 * refused before `verifiedAt` is flipped or the user doc is stamped, so a
 * victim's click never credits the caller. Guard: tests/uni-email-ownership.test.mjs.
 */
export async function confirmUniEmailVerification(
  db: Firestore,
  signed: string | undefined | null,
  callerUid: string | null,
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

  // Ownership binding — see the function's docblock. The confirming caller must
  // be the account the token was minted for, or a victim's click on a link an
  // attacker triggered would verify the attacker's claim on the victim's
  // address. Refused before any state change.
  if (!callerUid) {
    return {
      ok: false,
      error:
        "You need to be signed in as the account you started signing up with to verify this email. Open the link in that browser, or sign in first.",
      status: 401,
    };
  }
  if (!authUid || callerUid !== authUid) {
    return {
      ok: false,
      error:
        "This verification link is for a different account. Open it in the browser where you started signing up, or sign in with that account first.",
      status: 403,
    };
  }

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
