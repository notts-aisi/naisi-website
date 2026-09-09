import path from "node:path";
import type { NextConfig } from "next";

/**
 * The intended Content Security Policy, one directive per line. Read at build
 * time, so the auth handler domain baked in is the backend's own
 * (`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, which the Firebase SDK reaches for the
 * sign-in handshake). Reported, not enforced: see the header comment below.
 */
function contentSecurityPolicy(): string {
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const authOrigin = authDomain ? `https://${authDomain}` : "";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://lh3.googleusercontent.com https://i.ytimg.com",
    "font-src 'self' data:",
    `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com wss://firestore.googleapis.com https://firebasestorage.googleapis.com https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://www.google.com/recaptcha/ https://accounts.google.com/gsi/ ${authOrigin}`.trim(),
    `frame-src https://accounts.google.com/gsi/ https://www.google.com/recaptcha/ https://www.youtube-nocookie.com/embed/ https://www.youtube.com/embed/ https://www.loom.com/embed/ ${authOrigin}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root to this project. Without this, Turbopack
  // auto-detects based on nearby package-lock.json files and can pick up
  // `../package-lock.json` from the parent Projects/ folder, which breaks
  // the React Client Manifest ("Could not find the module global-error.js").
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        // Response headers every route carries, API routes and static files
        // included. Each one is a browser-side control on a class the server
        // cannot police by itself, and each is asserted on a real build by
        // scripts/e2e/tests/security-headers.test.mjs.
        source: "/:path*",
        headers: [
          // Two years, subdomains included: naisi.uk, dev.naisi.uk and the
          // auth handler domains are all HTTPS-only. Not `preload`: joining
          // the browser preload list is a commitment the domain's owner
          // makes, not a header a pull request flips.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          // Nothing frames this site. The only iframes in the product point
          // OUT (Google sign-in, reCAPTCHA, YouTube and Loom embeds, and a
          // `srcDoc` email preview), never at our own pages, so DENY and the
          // CSP's `frame-ancestors 'none'` say the same thing twice for the
          // browsers that read only one.
          { key: "X-Frame-Options", value: "DENY" },
          // Full URL to our own origin, origin only across origins, nothing
          // on a downgrade. Magic-link and unsubscribe URLs carry tokens in
          // the query, and a third-party image or embed must not see them.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Powerful features this site never asks for, switched off for the
          // page and every frame it embeds. File inputs (the worksheet image
          // answers) are not the camera feature and keep working.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // REPORT-ONLY, on purpose, and here is why. An enforced policy
          // would have to allow Next's own inline scripts (the hydration
          // payload every page carries as `self.__next_f.push(...)` and the
          // pre-paint installed-app flag in src/features/pwa/StandaloneFlag.tsx),
          // which means a per-request nonce set in src/proxy.ts, and Next's
          // CSP guide is explicit that nonces require dynamic rendering: the
          // home page's 600-second revalidation and the static policy pages
          // would all become per-request renders. That is a decision to take
          // with the numbers in hand, not a side effect of a header. Until
          // then the policy below is the INTENDED one, reported rather than
          // enforced, so the browser console on dev.naisi.uk lists exactly
          // what the enforced version would break and nothing is blocked.
          // The origins are the ones the client code reaches: Google
          // Identity Services and reCAPTCHA for scripts, frames and calls;
          // the Firebase Auth, Firestore, Storage and Installations
          // endpoints for calls; Storage, Google account photos and YouTube
          // thumbnails for images; YouTube and Loom for embeds; and the
          // project's own auth handler domain, which differs per backend.
          {
            key: "Content-Security-Policy-Report-Only",
            value: contentSecurityPolicy(),
          },
        ],
      },
      {
        // The service worker file must never be served stale: a cached
        // sw.js would delay both updates and, critically, the kill-switch
        // rollback path (scripts/pwa/sw-kill.js deployed over this URL).
        // Content-Type is deliberately NOT set here; Next already serves
        // .js from public/ correctly and a second value would risk a
        // duplicate header. Verify with `curl -I https://dev.naisi.uk/sw.js`.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
      {
        // The offline fallback is fetched once per worker install. no-cache
        // (not no-store) so the install picks up the current copy while
        // normal HTTP caching stays out of the picture.
        source: "/offline.html",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
  async redirects() {
    return [
      // Instagram bio link points at /stay-in-touch. Instagram appends its
      // own ?utm_source=ig&fbclid=... params, so the bare path 404s and the
      // real target (the #stay-in-touch section on the homepage) is
      // unreachable without this redirect. Query params forward by default,
      // and the # fragment is preserved by the browser following the redirect.
      {
        source: "/stay-in-touch",
        destination: "/#stay-in-touch",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
