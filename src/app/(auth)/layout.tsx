import Script from "next/script";
import type { Viewport } from "next";
import BrandMark from "@/components/BrandMark";
import AuthBodyLock from "./AuthBodyLock";
import LogoLink from "./LogoLink";
import styles from "./layout.module.css";

/** Lock viewport scaling on auth routes so the loader's touch attractor
 *  works cleanly with a finger and the layout can't be zoomed into a
 *  partial view. Combined with AuthBodyLock (scroll/overscroll disable)
 *  this gives the sign-in surface a stable finger-friendly canvas. */
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
