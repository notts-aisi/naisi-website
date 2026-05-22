import "server-only";
import { cookies } from "next/headers";
import { getAdminAuth, getAdminDb } from "./admin";

export const SESSION_COOKIE = "__session";
const SESSION_EXPIRES_IN_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export type Role = "pending" | "member" | "committee" | "admin" | "rejected";

export type SessionUser = {
  uid: string;
  email: string | null;
  role: Role;
  displayName?: string;
  /** True only for committee members the SU formally recognises. Admin-set;
   *  gates member-PII access and the committee task board. */
  suRecognised: boolean;
  permissions: {
    draftNewsletter: boolean;
    approveNewsletter: boolean;
    draftEvent: boolean;
    approveEvent: boolean;
  };
};

/** Exchange a Firebase ID token for a long-lived session cookie, written httpOnly. */
export async function createSessionCookie(idToken: string): Promise<void> {
  const auth = getAdminAuth();
  if (!auth) throw new Error("Firebase Admin not configured");

  const sessionCookie = await auth.createSessionCookie(idToken, {
    expiresIn: SESSION_EXPIRES_IN_MS,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, sessionCookie, {
    maxAge: SESSION_EXPIRES_IN_MS / 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

/**
 * Revoke every session for the signed-in user, then clear the cookie.
 *
 * Deleting the cookie alone only forgets the session on the current device;
 * the session-cookie JWT itself stays valid until its expiry, so a copied
 * cookie would survive "logout". revokeRefreshTokens invalidates it
 * everywhere - getCurrentUser already verifies with checkRevoked=true, so the
 * revocation takes effect on the very next request. This makes logout a real
 * logout rather than a per-device forget.
 */
export async function revokeAndClearSession(): Promise<void> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE);
  if (cookie?.value) {
    const auth = getAdminAuth();
    if (auth) {
      try {
        // No checkRevoked here: we only need the uid, and an already-revoked
        // cookie should still resolve so the revoke stays idempotent.
        const decoded = await auth.verifySessionCookie(cookie.value);
        await auth.revokeRefreshTokens(decoded.uid);
      } catch {
        // Cookie missing, malformed, or expired - nothing to revoke.
      }
    }
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Drop the session cookie on this device WITHOUT revoking refresh tokens.
 *
 * Use only when exiting an admin "view as" impersonation: the __session
 * cookie holds the target's session, but the target may have real signed-in
 * devices of their own. revokeAndClearSession would kick them out of those
 * sessions too, which is a side-effect of a debug feature acting on the
 * admin's browser - unacceptable. This helper just forgets the cookie here.
 *
 * For real sign-out always use revokeAndClearSession.
 */
export async function clearSessionCookieOnly(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Read + verify the session cookie, returning { uid, email, role }. Null if no/invalid session. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE);
  if (!cookie?.value) return null;

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) return null;

  try {
    const decoded = await auth.verifySessionCookie(cookie.value, true);
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    const data = userDoc.data() ?? {};
    const perms = (data.permissions as Record<string, unknown> | undefined) ?? {};
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      role: (data.role as Role) ?? "pending",
      displayName: data.displayName ?? data.profile?.preferredName,
      suRecognised: Boolean(data.suRecognised),
      permissions: {
        draftNewsletter: Boolean(perms.draftNewsletter),
        approveNewsletter: Boolean(perms.approveNewsletter),
        draftEvent: Boolean(perms.draftEvent),
        approveEvent: Boolean(perms.approveEvent),
      },
    };
  } catch {
    return null;
  }
}
