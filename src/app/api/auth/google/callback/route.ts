import { NextResponse, type NextRequest } from "next/server";
import { OAuth2Client } from "google-auth-library";

/*
 * GIS redirect-mode landing. On phones and installed apps the Google button
 * runs ux_mode: "redirect" (popup mode stays for desktop; see
 * GoogleSignInButton.tsx), and Google form-POSTs the result HERE instead of
 * handing it to client JavaScript:
 *
 *     credential=<google id token>&g_csrf_token=<random>
 *
 * with the same g_csrf_token in a cookie. This route verifies and then hands
 * the credential straight back to the client through a short-lived cookie,
 * redirecting to /login where AuthEntry consumes it and runs the EXACT same
 * exchangeGoogleCredential path popup mode uses. Deliberately no custom-token
 * mint and no server-side session creation here: keeping one downstream code
 * path means redirect mode cannot rot separately from popup mode.
 *
 * Checks, in order:
 *
 *   1. CSRF double-submit: body g_csrf_token must equal the cookie. Blocks
 *      login CSRF (an attacker POSTing THEIR credential so the victim ends up
 *      in the attacker's account). If the COOKIE is missing entirely we
 *      reject with a distinct marker: on an installed iOS app the Google leg
 *      runs in an in-app browser whose cookie jar may be separate from the
 *      app window's, and whether the cookie survives that handback is the
 *      open device question. The distinct marker makes the answer readable
 *      from the login page's error state on a real device.
 *   2. Full token verification (signature against Google's JWKS, aud, iss,
 *      expiry) via google-auth-library, which firebase-admin already depends
 *      on; it is declared in package.json now rather than borrowed. Firebase
 *      would reject a bad token later anyway, but verifying before setting
 *      any cookie means a forged POST cannot even place a value.
 *
 * The handoff cookie is deliberately NOT httpOnly: client JS must read it to
 * call signInWithCredential, exactly as it would have received the token in
 * popup mode, so the exposure is identical. Scoped to /login, 60 second
 * lifetime, consumed and deleted on first read.
 *
 * The redirect Location must be built from NEXT_PUBLIC_APP_URL, never from
 * request.url: on App Hosting the incoming Host header is the internal Cloud
 * Run revision URL, and a Location built from it would bounce the user off
 * the public origin. Local dev has no NEXT_PUBLIC_APP_URL mismatch, so
 * request.url is the fallback.
 */

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

/** Where AuthEntry looks for the credential. Mirrored in AuthEntry.tsx. */
const HANDOFF_COOKIE = "__google_credential";
/** Set by AuthEntry before redirect so the ?next= destination survives the
 *  round trip through Google. Mirrored in AuthEntry.tsx. */
const NEXT_COOKIE = "__auth_next";

function loginRedirect(request: NextRequest, params: Record<string, string>) {
  const base = process.env.NEXT_PUBLIC_APP_URL || request.url;
  const url = new URL("/login", base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // 303: the incoming request is a POST; the redirect must become a GET.
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  let credential: unknown, bodyCsrf: unknown;
  try {
    const form = await request.formData();
    credential = form.get("credential");
    bodyCsrf = form.get("g_csrf_token");
  } catch {
    return loginRedirect(request, { google_error: "bad-request" });
  }

  if (typeof credential !== "string" || credential.length === 0) {
    return loginRedirect(request, { google_error: "missing-credential" });
  }

  const cookieCsrf = request.cookies.get("g_csrf_token")?.value;
  if (!cookieCsrf) {
    // The diagnostic case for installed iOS apps; see the docblock.
    console.warn("[google-callback] g_csrf_token cookie absent");
    return loginRedirect(request, { google_error: "csrf-cookie-missing" });
  }
  if (typeof bodyCsrf !== "string" || bodyCsrf !== cookieCsrf) {
    console.warn("[google-callback] g_csrf_token mismatch");
    return loginRedirect(request, { google_error: "csrf-mismatch" });
  }

  if (!CLIENT_ID) {
    console.error("[google-callback] NEXT_PUBLIC_GOOGLE_CLIENT_ID unset");
    return loginRedirect(request, { google_error: "misconfigured" });
  }
  try {
    await new OAuth2Client(CLIENT_ID).verifyIdToken({
      idToken: credential,
      audience: CLIENT_ID,
    });
  } catch (err) {
    console.warn("[google-callback] token verification failed", err);
    return loginRedirect(request, { google_error: "invalid-token" });
  }

  // Restore the pre-redirect ?next= destination, with the same open-redirect
  // guard AuthEntry applies: same-origin path only, no protocol-relative.
  const params: Record<string, string> = { from: "google-redirect" };
  const next = request.cookies.get(NEXT_COOKIE)?.value;
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    params.next = next;
  }

  const res = loginRedirect(request, params);
  res.cookies.set(HANDOFF_COOKIE, credential, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/login",
    maxAge: 60,
  });
  res.cookies.set(NEXT_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
