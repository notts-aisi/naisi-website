"use client";

import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
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
 * Abandon an INCOMPLETE signup so the user can start fresh (e.g. with a
 * different email). Best-effort deletes the orphaned auth account — but ONLY
 * when there's genuinely no `users` doc AND no `collaborators` doc for the uid,
 * so a real member/collaborator who lands here is never deleted (they're just
 * signed out). Deleting frees the email for reuse. `user.delete()` can throw
 * `auth/requires-recent-login` on an old session; that's fine — we fall back to
 * a plain sign-out. Always finishes by signing out + clearing the session cookie.
 */
export async function startOver(): Promise<void> {
  const auth = getClientAuth();
  const current = auth.currentUser;
  if (current) {
    const db = getClientDb();
    let safeToDelete = false;
    try {
      const [userSnap, collabSnap] = await Promise.all([
        getDoc(doc(db, "users", current.uid)),
        getDocs(
          query(
            collection(db, "collaborators"),
            where("uid", "==", current.uid),
            limit(1),
          ),
        ),
      ]);
      // Only an orphan (no real account of either kind) is safe to delete.
      safeToDelete = !userSnap.exists() && collabSnap.empty;
    } catch {
      safeToDelete = false; // can't confirm it's an orphan → never delete
    }
    if (safeToDelete) {
      try {
        await current.delete();
      } catch {
        /* requires-recent-login etc. → fall through to a plain sign-out */
      }
    }
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
