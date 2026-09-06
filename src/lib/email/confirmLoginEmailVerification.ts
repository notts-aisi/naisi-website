import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminAuth } from "@/lib/firebase/admin";
import { verifyToken } from "@/lib/signedTokens";
import { safeFunnelReturn } from "@/lib/authReturn";
import { markRegistrationEmailVerified } from "@/lib/firestore/registrationWrites";

export type ConfirmLoginEmailResult =
  | {
      ok: true;
      email: string;
      /** "member" | "collaborator" — which form to resume. */
      audience: "member" | "collaborator";
      /** The funnel the person came from, or null. Stored on the token by
       *  POST /api/register so it survives an email opened on another device,
       *  where the `__auth_next` cookie does not exist. */
      next: string | null;
      /** Firebase custom token; the client signs in with it (option A: the
       *  magic-link click both verifies the email AND establishes the session). */
      customToken: string;
    }
  | { ok: false; error: string; status: number };

/**
 * Confirms the login-email magic link from POST /api/register. Unlike the
 * uni-email confirm (which only marks an attribute on an already-signed-in
 * user), this is the user's FIRST authentication: it marks the address verified
 * on both the token doc and the Firebase user, then mints a custom token so the
 * client can sign in and continue registration. Idempotent until the token
 * expires (a double-click just re-issues a session — the password they set is
 * the durable credential anyway).
 *
 * createCustomToken needs the runtime service account's
 * `serviceAccountTokenCreator` grant — already in place for the view-as feature.
 */
export async function confirmLoginEmailVerification(
  db: Firestore,
  signed: string | undefined | null,
): Promise<ConfirmLoginEmailResult> {
  if (!signed) return { ok: false, error: "Missing token", status: 400 };

  const payload = verifyToken(signed, "verify-login-email");
  if (!payload || payload.s !== "verify-login-email") {
    return { ok: false, error: "Invalid or expired link", status: 400 };
  }

  const ref = db.collection("emailVerifications").doc(payload.v);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, error: "Verification request not found", status: 404 };
  }

  const data = snap.data()!;
  if (data.kind !== "login-email") {
    return { ok: false, error: "Invalid link", status: 400 };
  }
  const expiresAt = data.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toMillis() <= Date.now()) {
    return { ok: false, error: "Link has expired", status: 410 };
  }

  const uid = data.uid as string | undefined;
  const email = (data.email as string | undefined) ?? "";
  const audience = data.audience === "collaborator" ? "collaborator" : "member";
  // Re-validated on the way out as well as on the way in: the redirect happens
  // here, so this is the last place that can refuse a stored address a widened
  // writer might one day put on the document. The typeof is part of that: the
  // allowlist takes a string, so a non-string on the document would throw
  // inside it and cost the reader the sign-in the link was for.
  const next = safeFunnelReturn(typeof data.next === "string" ? data.next : undefined);
  if (!uid) {
    return { ok: false, error: "Verification request is malformed", status: 400 };
  }

  const auth = getAdminAuth();
  if (!auth) return { ok: false, error: "Server not configured", status: 500 };

  // SINGLE USE. Redeeming this link mints a Firebase custom token, and the
  // landing page is a server component — so a plain GET yields a full session.
  // Anything that follows links (a mail-scanning proxy, a corporate link
  // rewriter, an inbox preview bot) can therefore redeem it, and previously the
  // link stayed redeemable for its whole expiry window because `verifiedAt`
  // was written and then never read.
  //
  // Claimed inside a transaction so the check and the write are atomic: two
  // concurrent redemptions cannot both observe verifiedAt == null and both
  // proceed to mint a token. Whoever loses gets the already-used message.
  let alreadyUsed = false;
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (fresh.get("verifiedAt")) {
      alreadyUsed = true;
      return;
    }
    tx.update(ref, { verifiedAt: Timestamp.now() });
  });
  if (alreadyUsed) {
    return {
      ok: false,
      error: "This sign-in link has already been used. Request a new one.",
      status: 410,
    };
  }
  try {
    await auth.updateUser(uid, { emailVerified: true });
  } catch (err) {
    console.error("[confirmLoginEmail] updateUser emailVerified failed", err);
  }

  // Mirror the verification onto the signup-tracker row so the admin console
  // shows "verified · no password" (best-effort — never blocks the sign-in).
  await markRegistrationEmailVerified(uid);

  let customToken: string;
  try {
    customToken = await auth.createCustomToken(uid);
  } catch (err) {
    console.error("[confirmLoginEmail] createCustomToken failed", err);
    return {
      ok: false,
      error:
        "Your email is verified, but we couldn't sign you in automatically. Head to the sign-in page and log in with your email and password.",
      status: 500,
    };
  }

  return { ok: true, email, audience, next, customToken };
}
