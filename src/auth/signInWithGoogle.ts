"use client";

import {
  getRedirectResult,
  signInWithRedirect,
  signOut as fbSignOut,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  getClientAuth,
  getClientDb,
  getGoogleProvider,
} from "@/lib/firebase/client";

export type SignInResult = {
  uid: string;
  email: string | null;
  isNew: boolean;
};

/**
 * Kick off Google sign-in via full-page redirect. Unlike `signInWithPopup`
 * this sidesteps Safari Intelligent Tracking Prevention and third-party
 * popup blockers that silently broke the previous popup flow.
 *
 * The browser navigates away to Google's auth screen, so this function
 * never resolves normally — the result is picked up on the return leg via
 * `consumeRedirectSignIn()` in the page that lands. Callers should still
 * await the call so their button shows a loading state during the brief
 * pre-navigation window, but must not expect a return value.
 */
export async function signInWithGoogle(): Promise<void> {
  const auth = getClientAuth();
  await signInWithRedirect(auth, getGoogleProvider());
}

/**
 * Handle the return leg of a redirect sign-in. Pages that expect to be
 * the redirect landing spot (login, register) call this on mount; pages
 * where there's no pending redirect get a null and no-op.
 *
 * On a real return, exchanges the Firebase ID token for a session cookie
 * (same /api/auth/session endpoint the old popup flow used) so server-side
 * route guards in (app)/layout.tsx pick up the signed-in state. The
 * `isNew` flag comes from the server checking whether a Firestore user
 * doc already exists — lets callers route new users to /register.
 */
export async function consumeRedirectSignIn(): Promise<SignInResult | null> {
  const auth = getClientAuth();
  const cred = await getRedirectResult(auth);
  if (!cred) return null;

  const user = cred.user;
  const idToken = await user.getIdToken();
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error("Failed to establish session");
  const body = (await res.json()) as { ok: boolean; exists: boolean };

  return {
    uid: user.uid,
    email: user.email,
    isNew: !body.exists,
  };
}

/**
 * Called by the /register form after Google auth + profile fields submitted.
 * Writes the initial users/{uid} doc with role: 'pending'.
 */
import type { AffiliationStatus, NewsletterPrefs } from "@/lib/firestore/users";

/** Drop undefined values — Firestore's `setDoc` rejects them outright. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export async function completeRegistration(profile: {
  preferredName: string;
  universityEmail: string;
  status: AffiliationStatus;
  statusOther?: string;
  subject: string;
  expectedGraduation?: string;
  motivation: string;
  interests?: string;
  newsletter: NewsletterPrefs;
}): Promise<void> {
  const auth = getClientAuth();
  const db = getClientDb();
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  await setDoc(doc(db, "users", user.uid), {
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    role: "pending",
    profile: compact(profile),
    showOnMembers: false,
    createdAt: serverTimestamp(),
  });

  // Fire-and-forget submission confirmation. User flow proceeds regardless.
  fetch("/api/admin/application-emails/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "application-submitted", uid: user.uid }),
  }).catch((err) => {
    console.warn("[submission email] fire-and-forget failed", err);
  });
}

export async function signOut() {
  await fbSignOut(getClientAuth());
  await fetch("/api/auth/session", { method: "DELETE" });
}
