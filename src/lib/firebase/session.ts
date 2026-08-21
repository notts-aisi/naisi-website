import "server-only";
import { cookies } from "next/headers";
import { bypass } from "@/lib/devBypass";
import type { CollaboratorStatus } from "@/lib/firestore/collaborators";
import { getAdminAuth, getAdminDb } from "./admin";

export const SESSION_COOKIE = "__session";
// Role-tiered session lifetime. Elevated roles (committee, admin) have
// broader access — member PII, drafter tools, the admin board, view-as
// impersonation — so a leaked/copied cookie carries more risk and we
// cap dwell time at 1 day. Pending / member / rejected get 5 days
// since the blast radius is small and re-auth is friction. Promotions
// mid-session keep the long cookie until next sign-in (the new role
// takes effect immediately via getCurrentUser's per-request doc read).
const SESSION_EXPIRES_IN_LONG_MS = 5 * 24 * 60 * 60 * 1000;
const SESSION_EXPIRES_IN_SHORT_MS = 1 * 24 * 60 * 60 * 1000;

export type Role = "pending" | "member" | "committee" | "admin" | "rejected";

function sessionDurationForRole(role: Role | undefined): number {
  if (role === "committee" || role === "admin") {
    return SESSION_EXPIRES_IN_SHORT_MS;
  }
  return SESSION_EXPIRES_IN_LONG_MS;
}

export type SessionUser = {
  uid: string;
  email: string | null;
  role: Role;
  displayName?: string;
  /** The combined policy version this member last accepted (e.g.
   *  "terms.1+privacy.2"). Compared against CURRENT_POLICY_VERSION to drive the
   *  re-consent gate. `null`/absent for legacy members who registered before it
   *  existed (treated as stale → re-consent, the safe default). Optional so the
   *  dev-bypass stub's SessionUser doesn't need it. */
  policyVersion?: string | null;
  /** True only for committee members the SU formally recognises. Admin-set;
   *  gates member-PII access and the committee task board. */
  suRecognised: boolean;
  permissions: {
    draftNewsletter: boolean;
    approveNewsletter: boolean;
    draftEvent: boolean;
    approveEvent: boolean;
    draftCourse: boolean;
    approveCourse: boolean;
  };
};

/**
 * Exchange a Firebase ID token for a session cookie, written httpOnly.
 * Cookie lifetime is sized to the caller's role: see
 * sessionDurationForRole above.
 */
export async function createSessionCookie(
  idToken: string,
  role?: Role,
): Promise<void> {
  const auth = getAdminAuth();
  if (!auth) throw new Error("Firebase Admin not configured");

  const expiresIn = sessionDurationForRole(role);
  const sessionCookie = await auth.createSessionCookie(idToken, { expiresIn });

  const store = await cookies();
  store.set(SESSION_COOKIE, sessionCookie, {
    maxAge: expiresIn / 1000,
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
  if (!cookie?.value) {
    // No real session, so fall back to the dev bypass if it's active
    // locally. The bypass stub returns null in production builds, so
    // this is a no-op there. A real session cookie always wins over
    // the bypass.
    return bypass.getServerUser();
  }

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
      policyVersion: typeof data.policyVersion === "string" ? data.policyVersion : null,
      suRecognised: Boolean(data.suRecognised),
      permissions: {
        draftNewsletter: Boolean(perms.draftNewsletter),
        approveNewsletter: Boolean(perms.approveNewsletter),
        draftEvent: Boolean(perms.draftEvent),
        approveEvent: Boolean(perms.approveEvent),
        draftCourse: Boolean(perms.draftCourse),
        approveCourse: Boolean(perms.approveCourse),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Verify the session cookie and return just `{ uid, email }` — no Firestore
 * read. Used by the collaborator API routes, which key off the auth uid and do
 * their own collection reads. Returns null when there is no valid session.
 */
export async function getSessionUid(): Promise<{
  uid: string;
  email: string | null;
} | null> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE);
  if (!cookie?.value) return null;

  const auth = getAdminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifySessionCookie(cookie.value, true);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    return null;
  }
}

export type SessionCollaborator = {
  /** Firestore doc id: `<name-slug>__<uid>`. */
  id: string;
  uid: string;
  email: string | null;
  emailVerified: boolean;
  fullName: string;
  status: CollaboratorStatus;
  /** Combined policy version this collaborator last accepted; drives the
   *  re-consent gate. `null` if none recorded. */
  policyVersion: string | null;
};

/**
 * Read + verify the session cookie, then resolve the `collaborators` doc for
 * this uid. The doc id is name-slugged, so we query the `uid` field rather than
 * doing a direct `doc()` get. Null when there is no session or no collaborator
 * doc. Gates the `/collaborator` area (and distinguishes a collaborator session
 * from a member one). A real member session — or no session — returns null here.
 */
export async function getCurrentCollaborator(): Promise<SessionCollaborator | null> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE);
  if (!cookie?.value) return null;

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) return null;

  try {
    const decoded = await auth.verifySessionCookie(cookie.value, true);
    const snap = await db
      .collection("collaborators")
      .where("uid", "==", decoded.uid)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = doc.data() ?? {};
    const status = data.status as CollaboratorStatus;
    return {
      id: doc.id,
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: Boolean(decoded.email_verified),
      fullName: (data.fullName as string) ?? "",
      status:
        status === "approved" || status === "rejected" ? status : "pending",
      policyVersion:
        typeof data.policyVersion === "string" ? data.policyVersion : null,
    };
  } catch {
    return null;
  }
}
