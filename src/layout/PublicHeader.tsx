"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandMark from "@/components/BrandMark";
import { useAuth } from "@/auth/AuthProvider";
import { signOut } from "@/auth/signInWithGoogle";
import styles from "./PublicHeader.module.css";

const NAV = [
  { label: "Members", href: "/members" },
  { label: "Resources", href: "/resources" },
  { label: "News", href: "/news" },
];

export default function PublicHeader() {
  const router = useRouter();
  const { user, role, loading } = useAuth();

  const isApproved = role === "member" || role === "committee" || role === "admin";
  const isPending = role === "pending";
  const isRejected = role === "rejected";

  async function handleSignOut() {
    await signOut();
    router.refresh();
  }

  return (
    <header className={styles.header}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.brand} aria-label="NAISI home">
          <BrandMark size={32} />
        </Link>
        <nav className={styles.nav} aria-label="Primary">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={styles.navLink}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className={styles.actions}>
          {loading ? null : user && isApproved ? (
            <>
              <Link href="/dashboard" className={styles.joinBtn}>
                Dashboard
              </Link>
              <button type="button" onClick={handleSignOut} className={styles.signIn}>
                Sign out
              </button>
            </>
          ) : user && isPending ? (
            <>
              <Link href="/pending-approval" className={styles.signIn}>
                Application status
              </Link>
              <button type="button" onClick={handleSignOut} className={styles.signIn}>
                Sign out
              </button>
            </>
          ) : user && isRejected ? (
            <>
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--color-danger)",
                  marginRight: "var(--space-2)",
                }}
                title="Your application wasn't approved. Sign out to try a different account."
              >
                Application not approved
              </span>
              <button type="button" onClick={handleSignOut} className={styles.joinBtn}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className={styles.signIn}>
                Sign in
              </Link>
              <Link href="/register" className={styles.joinBtn}>
                Join us
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
