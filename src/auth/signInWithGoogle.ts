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
import type { AffiliationStatus } from "@/lib/firestore/users";
import {
  serialiseNotifications,
  type NotificationPrefs,
} from "@/lib/firestore/notifications";

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
  notifications: NotificationPrefs;
  /** If present, server-side `uniEmailVerifiedAt` should be set from the
   * backing `emailVerifications` doc. The server treats this as a hint —
   * actual trust comes from the doc, not the client's say-so. */
  verifiedTokenId?: string;
  /** ISO timestamp stamped when the register tab saw verification complete. */
  uniEmailVerifiedAt?: Date;
}): Promise<void> {
  const auth = getClientAuth();
  const db = getClientDb();
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const { notifications, verifiedTokenId, uniEmailVerifiedAt, ...rest } = profile;
  const writableProfile: Record<string, unknown> = {
    ...compact(rest),
    notifications: serialiseNotifications(notifications),
    // Legacy compat — keep `newsletter` in sync so un-migrated read paths
    // (newsletter send, useNewsletterSubscribers) work during the transition.
    newsletter: {
      subscribed: notifications.categories.newsletter,
      deliverToGmail: notifications.channels.gmail,
      deliverToUniEmail: notifications.channels.uniEmail,
    },
  };
  if (uniEmailVerifiedAt) {
    writableProfile.uniEmailVerifiedAt = uniEmailVerifiedAt;
  }

  await setDoc(doc(db, "users", user.uid), {
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    role: "pending",
    profile: writableProfile,
    showOnMembers: false,
    createdAt: serverTimestamp(),
  });
  // verifiedTokenId is accepted into the signature for forward-compat with a
  // planned server-side authoritative stamp, but not sent anywhere yet —
  // uniEmailVerifiedAt above is the current source of truth.
  void verifiedTokenId;

  // Subscriptions sync — claims any pre-existing guest subscription rows
  // for this user's verified email(s) (so a homepage signer-upper who later
  // registers doesn't end up with a duplicate guest row), and applies the
  // form's notification prefs as a per-(email, channel) matrix. Fire-and-
  // forget so the register flow proceeds regardless; the sender already
  // gracefully handles a user who hasn't been synced yet.
  //
  // Derive the matrix from the legacy register-form shape: a category is
  // delivered to a given email iff the form ticked both the category and
  // that email's channel-routing flag. The /profile UI (post-register)
  // sends the matrix directly without this translation.
  const matrix: Record<string, { newsletter: boolean; events: boolean }> = {};
  const googleEmail = (user.email ?? "").trim().toLowerCase();
  if (googleEmail) {
    matrix[googleEmail] = {
      newsletter:
        notifications.categories.newsletter && notifications.channels.gmail,
      events: notifications.categories.events && notifications.channels.gmail,
    };
  }
  // Only include the uni email if the form recorded it as verified — the
  // sync route's helper double-checks this server-side, but matching the
  // gate here keeps payloads minimal.
  const uniEmailNorm = profile.universityEmail.trim().toLowerCase();
  if (uniEmailNorm && uniEmailVerifiedAt) {
    matrix[uniEmailNorm] = {
      newsletter:
        notifications.categories.newsletter && notifications.channels.uniEmail,
      events: notifications.categories.events && notifications.channels.uniEmail,
    };
  }
  fetch("/api/subscriptions/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matrix }),
  }).catch((err) => {
    console.warn("[subscriptions sync] fire-and-forget failed", err);
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
