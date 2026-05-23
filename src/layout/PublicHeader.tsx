"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandMark from "@/components/BrandMark";
import Drawer from "@/components/ui/Drawer";
import { useAuth } from "@/auth/AuthProvider";
import { signOut } from "@/auth/signInWithGoogle";
import styles from "./PublicHeader.module.css";

const NAV = [
  { label: "Members", href: "/members" },
  { label: "Resources", href: "/resources" },
  { label: "News", href: "/news" },
];

const DRAWER_ID = "public-nav-drawer";

export default function PublicHeader() {
  const router = useRouter();
  const { user, role } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isApproved = role === "member" || role === "committee" || role === "admin";
  const isPending = role === "pending";
  const isRejected = role === "rejected";

  const closeDrawer = () => setDrawerOpen(false);

  async function handleSignOut() {
    closeDrawer();
    await signOut();
    router.refresh();
  }

  /*
    Default to the signed-out Sign in / Join us buttons while auth is still
    resolving — an empty actions area for 2-3 seconds was the common
    complaint. If the user turns out to be signed in, clicking Sign in
    bounces through /login's effect which redirects to the correct
    destination based on role.
  */
  const renderDesktopAuth = () => {
    if (user && isApproved) {
      return (
        <>
          <Link href="/dashboard" className={styles.joinBtn}>
            Dashboard
          </Link>
          <button type="button" onClick={handleSignOut} className={styles.signIn}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isPending) {
      return (
        <>
          <Link href="/pending-approval" className={styles.signIn}>
            Application status
          </Link>
          <button type="button" onClick={handleSignOut} className={styles.signIn}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isRejected) {
      return (
        <>
          <span
            className={styles.rejectedLabel}
            title="Your application wasn't approved. Sign out to try a different account."
          >
            Application not approved
          </span>
          <button type="button" onClick={handleSignOut} className={styles.joinBtn}>
            Sign out
          </button>
        </>
      );
    }
    return (
      <>
        <Link href="/login" className={styles.signIn}>
          Sign in
        </Link>
        <Link href="/register" className={styles.joinBtn}>
          Join us
        </Link>
      </>
    );
  };

  const renderDrawerAuth = () => {
    if (user && isApproved) {
      return (
        <>
          <Link href="/dashboard" className={styles.drawerLink} onClick={closeDrawer}>
            Dashboard
          </Link>
          <button type="button" onClick={handleSignOut} className={styles.drawerLink}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isPending) {
      return (
        <>
          <Link href="/pending-approval" className={styles.drawerLink} onClick={closeDrawer}>
            Application status
          </Link>
          <button type="button" onClick={handleSignOut} className={styles.drawerLink}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isRejected) {
      return (
        <>
          <span className={styles.drawerRejected}>Application not approved</span>
          <button type="button" onClick={handleSignOut} className={styles.drawerLink}>
            Sign out
          </button>
        </>
      );
    }
    return (
      <>
        <Link href="/login" className={styles.drawerLink} onClick={closeDrawer}>
          Sign in
        </Link>
        <Link href="/register" className={styles.drawerLinkPrimary} onClick={closeDrawer}>
          Join us
        </Link>
      </>
    );
  };

  return (
    <>
      <header className={styles.header}>
        <div className={`container ${styles.inner}`}>
          <Link href="/" className={styles.brand} aria-label="NAISI home">
            <BrandMark size={40} />
          </Link>
          <nav className={styles.nav} aria-label="Primary">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className={styles.navLink}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className={styles.actions}>{renderDesktopAuth()}</div>
          <button
            type="button"
            className={styles.menuButton}
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            aria-expanded={drawerOpen}
            aria-controls={DRAWER_ID}
            onClick={() => setDrawerOpen(true)}
          >
            <span className={styles.menuIcon} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>
      </header>
      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        id={DRAWER_ID}
        ariaLabel="Site navigation"
      >
        <div className={styles.drawerBrand}>
          <BrandMark size={32} />
        </div>
        <nav className={styles.drawerNav} aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={styles.drawerLink}
              onClick={closeDrawer}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className={styles.drawerFooter}>{renderDrawerAuth()}</div>
      </Drawer>
    </>
  );
}
