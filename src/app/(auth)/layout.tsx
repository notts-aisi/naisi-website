import Link from "next/link";
import Script from "next/script";
import BrandMark from "@/components/BrandMark";
import styles from "./layout.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      {/* Google Identity Services — loaded only on auth routes (/login,
          /register, /pending-approval) so marketing pages don't pay the
          script cost. afterInteractive runs after hydration so React
          isn't blocked. GoogleSignInButton waits for window.google to
          appear before rendering. */}
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      <header className={styles.header}>
        <Link href="/" aria-label="NAISI home">
          <BrandMark size={32} />
        </Link>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
