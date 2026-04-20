import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/firebase/session";

/*
  Next 16 renamed middleware → proxy (same behaviour).

  The Next docs warn that Proxy isn't intended for slow data fetching — so this file
  only does a fast cookie-presence check. The full role gate (token verification,
  role lookup, redirects for pending/insufficient-role) happens in (app)/layout.tsx
  as a Server Component, where async Firestore calls are expected and won't block
  the Edge runtime.
*/

const PROTECTED_PREFIXES = ["/dashboard", "/tasks", "/credentials", "/calendar", "/profile", "/newsletter", "/admin"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const needsAuth = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!needsAuth) return NextResponse.next();

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/tasks/:path*", "/credentials/:path*", "/calendar/:path*", "/profile/:path*", "/newsletter/:path*", "/admin/:path*"],
};
