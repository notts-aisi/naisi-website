import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "./session";

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

/**
 * Does this marker annotate a genuinely BORROWED session?
 *
 * A marker whose `actorUid` equals the uid of the session it is attached to is
 * stale, not live: it means the admin is signed in as themselves again while a
 * cookie from a half-failed start (or a sign-in that never went through the
 * exit route) is still sitting in the browser. `(app)/layout.tsx` has always
 * suppressed the banner in that case, and `POST /api/admin/impersonate`
 * self-heals it by clearing the cookie. This is that one comparison, written
 * once so every caller answers the question the same way.
 *
 * `currentUid` is the uid `getCurrentUser()` resolves for the request. A null
 * uid (no session at all) cannot prove the marker is stale, so it stays live
 * and callers keep refusing.
 */
export function markerIsLive(
  marker: ImpersonatorMarker | null,
  currentUid: string | null,
): marker is ImpersonatorMarker {
  return marker !== null && marker.actorUid !== currentUid;
}

/**
 * The marker, but only when it describes a live view-as session. Reads the
 * session itself, so it is the right helper for a caller that does not already
 * hold the current user; a caller that does (a layout that has just gated on
 * it) should use `markerIsLive()` and save the second session read.
 */
export async function getLiveImpersonator(): Promise<ImpersonatorMarker | null> {
  const marker = await getImpersonator();
  if (!marker) return null;
  const user = await getCurrentUser();
  return markerIsLive(marker, user?.uid ?? null) ? marker : null;
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
 * A STALE marker (`actorUid` equal to the current session's uid, so the admin
 * is signed in as themselves again) is not a session: it is cleared here, the
 * same self-heal `POST /api/admin/impersonate` does, and the write proceeds.
 * Refusing on it would leave an admin locked out of their own high-trust
 * routes until they thought to clear a cookie they cannot see.
 *
 * HONEST LIMIT, and it is worth being exact about what this covers:
 *
 *  - COVERED: every mutating route handler under the trees listed in
 *    `tests/impersonation-guard.test.mjs`, which is where the writes that
 *    decide, allocate, publish, remove, mark attendance, review work, send
 *    email, change status or destroy actually live.
 *  - COVERED: the whole `/admin` page tree, which `(app)/admin/layout.tsx`
 *    closes during a view-as session precisely because the course editors
 *    under it write to Firestore client-direct, with no route handler in the
 *    path for this guard to sit in.
 *  - NOT COVERED: client-direct Firestore writes from any other surface. Those
 *    answer to `firestore.rules` alone, and rules see the target, because
 *    view-as swaps the session. If a new surface writes client-direct, closing
 *    its page tree (or routing the write) is the fix; this guard cannot reach
 *    it.
 *  - NOT COVERED: an admin who deletes the cookie. It is httpOnly, so no page
 *    script can remove it, but devtools can. This enforces intent against
 *    accidents, not against an admin who has decided to defeat it, and an
 *    admin already holds the rights to make these writes under their own name.
 */
export async function assertNotImpersonating(): Promise<NextResponse | null> {
  const marker = await getImpersonator();
  if (!marker) return null;
  const user = await getCurrentUser();
  if (!markerIsLive(marker, user?.uid ?? null)) {
    // Cookie mutation is legal here: every caller is a route handler.
    // Best-effort, because a failure to clear must not turn into a 500 on a
    // write that is allowed to proceed.
    try {
      await clearImpersonatorCookie();
    } catch {
      /* the marker outlives this request; the next one heals it */
    }
    return null;
  }
  return NextResponse.json(
    { error: IMPERSONATION_BLOCKED_MESSAGE },
    { status: 403 },
  );
}
