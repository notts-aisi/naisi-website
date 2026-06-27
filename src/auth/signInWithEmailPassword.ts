"use client";

import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";
import { isAcademicEmail, isNottinghamEmail } from "@/lib/firestore/users";
import { signOut } from "./signInWithGoogle";

/**
 * Email + password auth for external collaborators. Parallels
 * `signInWithGoogle.ts`: after Firebase signs the user in client-side we hand
 * the freshly-minted Firebase ID token to /api/auth/session, which mints the
 * `__session` cookie. The session route is provider-agnostic — it returns a
 * `kind` discriminator (member | collaborator | new) so the caller can route.
 */

export type EmailAuthKind = "member" | "collaborator" | "new";

export type EmailAuthResult = {
  uid: string;
  email: string | null;
  /** member = has a users doc; collaborator = has a collaborators doc; new = neither. */
  kind: EmailAuthKind;
  /** True when a users doc already exists (mirrors exchangeGoogleCredential). */
  exists: boolean;
};

/** POST the current user's Firebase ID token to mint the session cookie. */
async function exchangeForSession(): Promise<EmailAuthResult> {
  const auth = getClientAuth();
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const idToken = await user.getIdToken();
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error("Failed to establish session");
  const body = (await res.json()) as {
    ok: boolean;
    exists: boolean;
    kind?: EmailAuthKind;
  };
  return {
    uid: user.uid,
    email: user.email,
    kind: body.kind ?? "new",
    exists: Boolean(body.exists),
  };
}

/** Map the common Firebase Auth error codes to friendly, user-facing copy. */
function friendlyError(err: unknown): Error {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/missing-password": "Please enter your password.",
    "auth/weak-password": "Please choose a password of at least 6 characters.",
    "auth/email-already-in-use":
      "An account already exists for that email. Try signing in instead.",
    "auth/invalid-credential": "That email or password isn't right.",
    "auth/wrong-password": "That email or password isn't right.",
    "auth/user-not-found": "That email or password isn't right.",
    "auth/too-many-requests":
      "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed":
      "Network error. Check your connection and try again.",
    // Surfaces clearly when the Email/Password provider hasn't been enabled in
    // the Firebase console (the documented PR-0 prerequisite).
    "auth/operation-not-allowed":
      "Email sign-in isn't enabled yet. (Enable Email/Password in the Firebase console.)",
  };
  return new Error(map[code] ?? "Something went wrong. Please try again.");
}

/**
 * Create an email/password account, fire a (best-effort) verification email,
 * and establish the session. Used by BOTH the collaborator apply flow and UoN
 * member registration — the Firestore doc (collaborators or users) is written
 * separately by the caller (POST /api/collaborators / completeRegistration).
 */
export async function signUpWithEmailPassword(
  email: string,
  password: string,
): Promise<EmailAuthResult> {
  const auth = getClientAuth();
  // The sign-in identity must be a PERMANENT personal email. Academic/institution
  // addresses lapse when you graduate or change jobs, so keying an account to one
  // locks people out; a UoN member signing up with theirs would also double up
  // with the Google member flow. Affiliation is proven separately (magic-link).
  // Applies to BOTH the member and collaborator email/password paths.
  if (isAcademicEmail(email)) {
    throw new Error(
      isNottinghamEmail(email)
        ? "That's a University of Nottingham email. Sign in with a personal email " +
          "(e.g. you@gmail.com) instead — university addresses stop working after " +
          "you graduate. Current students and staff register on the student/staff " +
          "form, where you'll confirm your university email separately."
        : "Please sign in with a personal email you'll keep long-term " +
          "(e.g. you@gmail.com) rather than an academic address — institution " +
          "emails stop working when you change institution.",
    );
  }
  let credUser;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    credUser = cred.user;
  } catch (err) {
    throw friendlyError(err);
  }
  // Verification is encouraged but must not block the apply flow.
  try {
    await sendEmailVerification(credUser);
  } catch (e) {
    console.warn("[collab signup] sendEmailVerification failed", e);
  }
  return exchangeForSession();
}

/** Sign an existing collaborator back in with email + password. */
export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<EmailAuthResult> {
  const auth = getClientAuth();
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    throw friendlyError(err);
  }
  return exchangeForSession();
}

/**
 * Abandon/delete an INCOMPLETE signup (registered, maybe set a password, but
 * never submitted a profile/application). Routes through the server cascade
 * (`POST /api/account/delete`), which tears down the orphan's Auth account,
 * `registrations` tracker row, and subscriptions in one place. A client-only
 * `user.delete()` couldn't touch the locked `registrations` doc and left a ghost
 * tracker row behind — this fixes that. The route enforces the unfinished-only
 * scope SERVER-side (a real member/collaborator is refused, never deleted), so
 * this is safe to call from any "start over" / "delete account" affordance.
 * Always finishes by signing out + clearing the session cookie.
 */
export async function startOver(): Promise<void> {
  // Best-effort: the cascade is cleanup, not the point — "start over" must always
  // return the user to a clean slate, so it signs out regardless of the result (a
  // 401 at the pre-verify step, a 409 on a finished account, a 500, or a network
  // error all still end in a sign-out). The server is the gate, so a failed or
  // refused call never deletes a real account.
  try {
    await fetch("/api/account/delete", { method: "POST" });
  } catch {
    /* network error → still sign out below */
  }
  await signOut();
}

/**
 * "Delete my account" for an unfinished registration. Unlike {@link startOver}
 * (best-effort), this is STRICT: it inspects the response and THROWS on a refusal
 * (409 finished account) or failure (500 / network) WITHOUT signing out, so the
 * caller can surface the error and not redirect as if the delete succeeded. Only
 * a 2xx — or a 207 (data removed, Auth orphan left for the tracker) — signs out.
 */
export async function deleteOwnAccount(): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/account/delete", { method: "POST" });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok && res.status !== 207) {
    let message = "Couldn't delete this account. Please try again.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep the default message */
    }
    throw new Error(message);
  }
  await signOut();
}

/** Send a Firebase password-reset email. */
export async function resetCollaboratorPassword(email: string): Promise<void> {
  const auth = getClientAuth();
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err) {
    throw friendlyError(err);
  }
}
