"use client";

/*
 * Last-resort error boundary. Next renders this when the root layout itself
 * throws, which means it REPLACES the root layout: no <html>, no <body>, no
 * globals.css, no next/font variables, no AuthProvider, no SiteNoticeBanner.
 *
 * Everything here is therefore deliberately self-contained:
 *
 *   - It renders its own <html> and <body>, because nothing else will.
 *   - Every style is inline. A CSS Module import would compile, but the
 *     stylesheet it produces is not guaranteed to have loaded in the failure
 *     mode this file exists for, and an unstyled white page on a site that is
 *     black everywhere else reads as "broken" rather than "handled".
 *   - Colours are literal hex rather than var(--color-*), for the same reason:
 *     tokens.css is imported by globals.css, which is not here.
 *   - The font is a system stack, because the next/font CSS variables live on
 *     the <html> the root layout would have rendered.
 *   - The only asset it references is a static file under public/, which is
 *     served independently of the app bundle.
 *
 * tests/global-error-self-contained.test.mjs enforces the no-CSS-import rule,
 * because the failure it guards against is invisible until the day it matters.
 *
 * Why this matters more now: in a browser tab a wedged page still has a URL
 * bar and a reload button. In an installed home-screen app it has neither, so
 * without a reachable "Try again" the only way out is force-quitting the app.
 */

const PAGE_FLOOR = "#050810";
const TEXT = "#e6eaf2";
const TEXT_MUTED = "#8b94ac";
const ACCENT = "#6a82ff";
const BORDER = "#2a344d";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          background: PAGE_FLOOR,
          color: TEXT,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <main style={{ maxWidth: "26rem", textAlign: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icons/icon-192.png"
            alt=""
            width={56}
            height={56}
            style={{ display: "block", margin: "0 auto 1.5rem", borderRadius: 12 }}
          />
          <h1 style={{ margin: "0 0 0.75rem", fontSize: "1.5rem", fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 1.5rem", color: TEXT_MUTED, lineHeight: 1.55 }}>
            The page hit an error it could not recover from. Trying again usually
            works.
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                // Safari paints its own grey button face over a background set
                // on a <button>, so appearance has to be reset explicitly.
                appearance: "none",
                WebkitAppearance: "none",
                minHeight: "2.75rem",
                padding: "0 1.25rem",
                borderRadius: 999,
                border: "none",
                background: ACCENT,
                color: "#ffffff",
                font: "inherit",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/*
              A plain <a>, not next/link, and the lint rule is disabled
              deliberately. Link does a client-side navigation through the
              very React tree that has just failed; a full document load is
              the whole point of this escape hatch, because it discards the
              broken tree, the route cache and the segment cache with it.
            */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: "2.75rem",
                padding: "0 1.25rem",
                borderRadius: 999,
                border: `1px solid ${BORDER}`,
                color: TEXT,
                font: "inherit",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Go to the homepage
            </a>
          </div>
          {error.digest ? (
            <p style={{ marginTop: "2rem", color: "#5b6785", fontSize: "0.75rem" }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
