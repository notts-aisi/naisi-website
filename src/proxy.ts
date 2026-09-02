import { NextResponse, type NextRequest } from "next/server";
import { bypass } from "@/lib/devBypass";
import { SESSION_COOKIE } from "@/lib/firebase/session";

/*
  Next 16 renamed middleware → proxy (same behaviour).

  The Next docs warn that Proxy isn't intended for slow data fetching — so this file
  only does a fast cookie-presence check. The full role gate (token verification,
  role lookup, redirects for pending/insufficient-role) happens in (app)/layout.tsx
  as a Server Component, where async Firestore calls are expected and won't block
  the Edge runtime.
*/

/*
  `/applications` (the applicant status hub) is on this list while
  `/apply/[roundId]` deliberately is not, and the difference is what each page
  is for. The apply page is discovery: a signed-out visitor should be able to
  read what a round is and get a sign-in card with a return address. The status
  hub is nothing but per-account state, so there is nothing on it to read
  signed out, and the honest answer is the sign-in screen.

  A COOKIE CHECK, not a role check: a `pending` account has a session cookie
  and must reach the hub, because the people most likely to open it are the
  ones who made an account at the fair and are still waiting on approval. The
  page itself lives in `(public)` for that same reason.
*/
const PROTECTED_PREFIXES = ["/dashboard", "/tasks", "/credentials", "/calendar", "/profile", "/newsletter", "/admin", "/collaborator", "/learn", "/applications"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const needsAuth = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!needsAuth) return NextResponse.next();

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  // No real session cookie. If the dev bypass is active locally, let the
  // request through and let (app)/layout.tsx's getCurrentUser resolve the
  // fake admin. The bypass stub is `isActive: false` in production builds,
  // so this branch is dead code in deployed environments.
  if (bypass.isActive) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/tasks/:path*", "/credentials/:path*", "/calendar/:path*", "/profile/:path*", "/newsletter/:path*", "/admin/:path*", "/collaborator/:path*", "/learn/:path*", "/applications/:path*"],
};
