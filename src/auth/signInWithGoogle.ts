"use client";

import {
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  getClientAuth,
  getClientDb,
  getGoogleProvider,
} from "@/lib/firebase/client";
import { mark, warn } from "@/lib/devMonitor";

export type SignInResult = {
  uid: string;
  email: string | null;
  isNew: boolean;
};

/**
 * Whether to use popup instead of redirect. Redirect requires the auth
 * domain to be on the same eTLD+1 as the app so the post-OAuth iframe
 * can read its sessionStorage from the app origin (Safari ITP / Chrome
 * storage partitioning block cross-eTLD+1 access). On localhost we have
 * no such shared apex with `*.firebaseapp.com`, so redirect can't
 * recover the credential and we fall back to popup, which uses
 * window.opener.postMessage and isn't affected.
 *
 * Prod (naisi.uk + auth.naisi.uk) and the deployed dev backend
 * (dev.naisi.uk + auth-website-dev.naisi.uk) both share apex naisi.uk,
 * so they use redirect — which is the whole reason we migrated away
 * from popup (Safari blocking popups in real browsers).
 */
function shouldUsePopup(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true; // LAN IP for phone testing
  return false;
}

/**
 * Kicks off Google sign-in. Two paths:
 *
 * - **Popup** (localhost): completes inline, returns the SignInResult
 *   (id-token already exchanged for a session cookie).
 * - **Redirect** (deployed): navigates the browser away to
 *   `auth.naisi.uk/__/auth/handler/...`; resolves to null because the
 *   page is torn down. The caller should rely on `consumeGoogleRedirect`
 *   on the next mount to pick up the result. A thrown rejection means
 *   the redirect couldn't even start.
 *
 * The auth subdomain is a Firebase Hosting first-party custom domain
 * specifically to dodge Safari ITP — see apphosting.yaml.
 */
export async function signInWithGoogle(): Promise<SignInResult | null> {
  const auth = getClientAuth();
  const provider = getGoogleProvider();

  if (shouldUsePopup()) {
    console.log("[signin] trigger: popup mode (localhost)");
    mark("[signin] popup start");
    const cred = await signInWithPopup(auth, provider);
    const user = cred.user;
    mark("[signin] popup resolved", { uid: user.uid, email: user.email });

    const idToken = await user.getIdToken();
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      warn("[signin] /api/auth/session failed", { status: res.status });
      throw new Error("Failed to establish session");
    }
    const body = (await res.json()) as { ok: boolean; exists: boolean };
    mark("[signin] session cookie established (popup)", { exists: body.exists });
    return { uid: user.uid, email: user.email, isNew: !body.exists };
  }

  console.log("[signin] trigger: redirect mode (deployed)");
  mark("[signin] redirect start");
  await signInWithRedirect(auth, provider);
  // Unreachable in the happy path — the browser has already navigated away.
  console.log("[signin] trigger: signInWithRedirect returned without navigating");
  return null;
}

/**
 * Consumes the post-redirect result on page load: pulls the credential
 * (or null if no sign-in is pending), exchanges its idToken for a session
 * cookie via /api/auth/session, and reports whether the user already has a
 * Firestore profile doc so the caller can route to /register vs. /next.
 *
 * Module-level dedup of the in-flight promise is load-bearing. React's
 * Strict Mode in dev runs the calling useEffect twice; without dedup, the
 * second call hits Firebase's already-consumed redirect state and returns
 * null, while the first call (now wrapped in a `cancelled` cleanup)
 * silently drops the routing decision. With dedup both mounts await the
 * same promise and both see the real SignInResult — the active mount
 * routes, the cancelled one bails harmlessly. The cache persists for the
 * page-load lifetime; the next signInWithRedirect is a fresh navigation
 * that resets module state.
 *
 * Server-side `exists` is the source of truth — a client-SDK Firestore
 * read here would race the fresh auth token attachment.
 *
 * Role-based routing happens in (app)/layout.tsx, not here.
 */
let inFlight: Promise<SignInResult | null> | null = null;

export function consumeGoogleRedirect(): Promise<SignInResult | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const auth = getClientAuth();
    console.log("[signin] consume: calling getRedirectResult");
    const cred = await getRedirectResult(auth);
    if (!cred) {
      console.log("[signin] consume: no pending redirect");
      mark("[signin] no pending redirect");
      return null;
    }
    const user = cred.user;
    console.log("[signin] consume: redirect resolved", {
      uid: user.uid,
      email: user.email,
    });
    mark("[signin] redirect resolved", { uid: user.uid, email: user.email });

    const idToken = await user.getIdToken();
    mark("[signin] getIdToken done", { length: idToken.length });

    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    console.log("[signin] consume: /api/auth/session POST returned", {
      status: res.status,
      ok: res.ok,
    });
    mark("[signin] /api/auth/session POST returned", {
      status: res.status,
      ok: res.ok,
    });
    if (!res.ok) {
      warn("[signin] /api/auth/session failed", { status: res.status });
      throw new Error("Failed to establish session");
    }
    const body = (await res.json()) as { ok: boolean; exists: boolean };
    console.log("[signin] consume: session cookie established", {
      exists: body.exists,
    });
    mark("[signin] session cookie established", { exists: body.exists });

    return {
      uid: user.uid,
      email: user.email,
      isNew: !body.exists,
    };
  })();
  return inFlight;
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
  mark("[signout] start");
  await fbSignOut(getClientAuth());
  mark("[signout] firebase signOut done");
  await fetch("/api/auth/session", { method: "DELETE" });
  mark("[signout] /api/auth/session DELETE done");
}
