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

export async function clearSessionCookie(): Promise<void> {
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
