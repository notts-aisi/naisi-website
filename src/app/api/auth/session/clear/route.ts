import { NextResponse } from "next/server";
import { clearSessionCookieOnly } from "@/lib/firebase/session";

/**
 * Drop the __session cookie WITHOUT revoking refresh tokens.
 *
 * Deliberately not DELETE /api/auth/session. That route calls
 * revokeAndClearSession(), which runs auth.revokeRefreshTokens(uid) and so
 * signs the user out of every device they own. That is correct for a
 * user-initiated sign-out and wrong for an automatic repair:
 *
 *   - The state this route exists for is "the server has a valid session
 *     cookie but the client has no Firebase Auth user". A phone that has
 *     landed in it should not sign the same person out of their laptop.
 *   - Worse, during an admin view-as session the cookie holds the TARGET's
 *     session, so an automatic revoke fired from an admin's browser would
 *     revoke a member's tokens everywhere.
 *
 * The impersonation-exit route (/api/admin/impersonate/exit) already uses
 * clearSessionCookieOnly for exactly the second reason. This is the same
 * judgement applied to the same primitive.
 *
 * No auth check and nothing to authorise: the only thing it can do is delete
 * the caller's own cookie, which the caller could do by clearing their own
 * browser storage.
 */
export async function POST() {
  await clearSessionCookieOnly();
  return NextResponse.json({ ok: true });
}
