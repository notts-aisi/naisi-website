import "server-only";
import { cookies } from "next/headers";

/**
 * Admin "view as" impersonation marker. Set by /api/admin/impersonate when
 * an admin starts a view-as session; cleared by /api/admin/impersonate/exit.
 *
 * The `__session` cookie itself is swapped to the *target's* session during
 * impersonation (full impersonation - request.auth becomes the target), so
 * this marker is the only signal the server has that the current session
 * is borrowed rather than the real owner's. It powers the banner in
 * AppShell and lets the exit route find the audit doc to close.
 */

export const IMPERSONATOR_COOKIE = "__impersonator";

// Match the session-cookie lifetime so the marker can never outlive the
// session it annotates. If the session expires the banner stops mattering.
const IMPERSONATOR_EXPIRES_IN_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export type ImpersonatorMarker = {
  /** The real admin's uid - present so the layout can detect a stale marker
   *  (a cookie that outlived a legitimate re-login) by comparing to the
   *  current session user's uid. */
  actorUid: string;
  /** Display name for the banner. */
  actorName: string;
  /** Admin's email at start time. Surfaced in the banner tooltip / audit. */
  actorEmail: string | null;
  /** Firestore `impersonations/{id}` doc id - used by the exit route to
   *  close out the audit log entry. */
  auditId: string;
};

export async function getImpersonator(): Promise<ImpersonatorMarker | null> {
  const store = await cookies();
  const cookie = store.get(IMPERSONATOR_COOKIE);
  if (!cookie?.value) return null;
  try {
    const parsed = JSON.parse(cookie.value) as Partial<ImpersonatorMarker>;
    if (
      typeof parsed.actorUid !== "string"
      || typeof parsed.actorName !== "string"
      || typeof parsed.auditId !== "string"
    ) {
      return null;
    }
    return {
      actorUid: parsed.actorUid,
      actorName: parsed.actorName,
      actorEmail: typeof parsed.actorEmail === "string" ? parsed.actorEmail : null,
      auditId: parsed.auditId,
    };
  } catch {
    return null;
  }
}

export async function setImpersonatorCookie(marker: ImpersonatorMarker): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATOR_COOKIE, JSON.stringify(marker), {
    maxAge: IMPERSONATOR_EXPIRES_IN_MS / 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function clearImpersonatorCookie(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATOR_COOKIE);
}
