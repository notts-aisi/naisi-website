import Script from "next/script";
import type { Viewport } from "next";
import BrandMark from "@/components/BrandMark";
import AuthBodyLock from "./AuthBodyLock";
import LogoLink from "./LogoLink";
import styles from "./layout.module.css";

/*
 * Lock viewport scaling on auth routes so the loader's touch attractor works
 * cleanly with a finger and the layout can't be zoomed into a partial view.
 * Combined with AuthBodyLock (scroll/overscroll disable) this gives the
 * sign-in surface a stable finger-friendly canvas.
 *
 * `viewportFit: "cover"` is DELIBERATELY absent, not dropped. Next's
 * mergeViewport (lib/metadata/resolve-metadata.js) iterates the child's own
 * keys and only overrides those, so an omitted key inherits from the root
 * layout. These routes therefore already run full-bleed, and so does the
 * root's themeColor. Verified against a running build: /login serves
 * `viewport-fit=cover` alongside the four keys below. Do not "restore" it
 * here; that would be a no-op that implies the opposite.
 *
 * KNOWN TRADEOFF, deliberately left alone: `userScalable: false` plus
 * `maximumScale: 1` fails WCAG 1.4.4, and while Safari has ignored it in a
 * normal tab since iOS 10, an installed home-screen app is a stricter
 * context. The obvious fix is to delete both keys, but that is not safe on
 * its own: AuthBodyLock sets overflow:hidden on <html> and locks body scroll,
 * so a visitor who pinch-zoomed in would have no way to pan to the rest of
 * the form. The zoom lock and the scroll lock have to be revisited together,
 * as their own change. Note the usual reason for a zoom lock is already
 * handled properly elsewhere: registerSignIn.module.css pins inputs to 16px
 * specifically so iOS does not focus-zoom.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <AuthBodyLock />
      {/* Google Identity Services — loaded only on auth routes (/login,
          /register, /pending-approval) so marketing pages don't pay the
          script cost. afterInteractive runs after hydration so React
          isn't blocked. GoogleSignInButton waits for window.google to
          appear before rendering. */}
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      <header className={styles.header}>
        <LogoLink aria-label="NAISI home">
          <BrandMark size={32} />
        </LogoLink>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
