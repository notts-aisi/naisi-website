import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminAuth } from "@/lib/firebase/admin";
import { verifyToken } from "@/lib/signedTokens";
import { markRegistrationEmailVerified } from "@/lib/firestore/registrationWrites";

export type ConfirmLoginEmailResult =
  | {
      ok: true;
      email: string;
      /** "member" | "collaborator" — which form to resume. */
      audience: "member" | "collaborator";
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
  if (!uid) {
    return { ok: false, error: "Verification request is malformed", status: 400 };
  }

  const auth = getAdminAuth();
  if (!auth) return { ok: false, error: "Server not configured", status: 500 };

  if (!data.verifiedAt) {
    await ref.update({ verifiedAt: Timestamp.now() });
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

  return { ok: true, email, audience, customToken };
}
