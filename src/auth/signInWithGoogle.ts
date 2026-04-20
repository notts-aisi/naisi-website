"use client";

import { signInWithPopup, signOut as fbSignOut } from "firebase/auth";
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
 * Google sign-in + session cookie provisioning.
 * The server (via /api/auth/session) tells us whether a user doc exists —
 * relying on a server-side check avoids the client-SDK race where Firestore
 * reads fire before the fresh auth token is attached.
 * Role-based routing happens in (app)/layout.tsx, not here.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  const auth = getClientAuth();
  const cred = await signInWithPopup(auth, getGoogleProvider());
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
}

export async function signOut() {
  await fbSignOut(getClientAuth());
  await fetch("/api/auth/session", { method: "DELETE" });
}
