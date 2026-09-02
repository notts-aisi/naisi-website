import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

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

/** The copy a blocked write returns. Exported so tests and any future client
 *  handling match the string exactly rather than guessing at it. */
export const IMPERSONATION_BLOCKED_MESSAGE =
  "This action is disabled while viewing as another member. Exit the view-as session and try again as yourself.";

/**
 * Refuse a high-trust write while an admin is in a view-as session.
 *
 * View-as is a full impersonation: the `__session` cookie holds the TARGET's
 * session, so `getCurrentUser()` returns the target and Firestore records
 * every write as the target performing it. That is exactly what makes the tool
 * useful for reproducing "the Events tab isn't showing for me", and exactly
 * what makes it unsafe for anything that decides, allocates, publishes,
 * removes, marks attendance, reviews work, sends email, changes status or
 * destroys: the audit trail would name the member, not the admin who acted.
 * The `impersonations` log records only the start and end of the window, so
 * per-write attribution is not reconstructable after the fact.
 *
 * Usage, at the very top of the handler, before any other work:
 *
 *   const blocked = await assertNotImpersonating();
 *   if (blocked) return blocked;
 *
 * Returns `null` when there is no view-as session, so the caller carries on.
 *
 * HONEST LIMIT: the marker is the `__impersonator` cookie. It is httpOnly, so
 * no page script can remove it, but an admin with devtools open can delete it
 * from their own browser and then write as the target with nothing to stop
 * them. This guard records and enforces intent against accidents. It is not a
 * defence against an admin who has decided to defeat it, and an admin already
 * holds the rights to make these writes under their own name.
 */
export async function assertNotImpersonating(): Promise<NextResponse | null> {
  const marker = await getImpersonator();
  if (!marker) return null;
  return NextResponse.json(
    { error: IMPERSONATION_BLOCKED_MESSAGE },
    { status: 403 },
  );
}
