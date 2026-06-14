"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandMark from "@/components/BrandMark";
import Drawer from "@/components/ui/Drawer";
import JoinMenu from "@/components/ui/JoinMenu";
import TransitionLink from "./TransitionLink";
import { usePublicTransition } from "./PublicMain";
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
  // Banner lifts off the top of the screen on Sign in / Join us. The
  // context fires `headerLifting` BEFORE the body fade-out (`exiting`)
  // so the banner clears the viewport as a discrete moment before the
  // page transitions away.
  const publicTransition = usePublicTransition();
  const headerExiting = publicTransition?.headerLifting ?? false;
  // Entrance: mount with .headerInitial (offscreen-up + invisible).
  // After one animation frame, strip the class — the transition then
  // smoothly interpolates the header into place. Using transitions
  // instead of @keyframes animation eliminates the conflict that made
  // the exit feel jumpy when it interrupted the entrance animation.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

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
          <TransitionLink href="/dashboard" className={styles.joinBtn}>
            Dashboard
          </TransitionLink>
          <button type="button" onClick={handleSignOut} className={styles.signIn}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isPending) {
      return (
        <>
          <TransitionLink href="/pending-approval" className={styles.signIn}>
            Application status
          </TransitionLink>
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
        <TransitionLink href="/login" className={styles.signIn}>
          Sign in
        </TransitionLink>
        {/* Join us is now a chooser: UoN member vs external collaborator.
            Desktop = popover; on smaller viewports the same component drops a
            bottom sheet. The mobile drawer below uses plain links instead, to
            avoid nesting a sheet inside the drawer portal. */}
        <JoinMenu className={styles.joinBtn} />
      </>
    );
  };

  const renderDrawerAuth = () => {
    if (user && isApproved) {
      return (
        <>
          <TransitionLink
            href="/dashboard"
            className={styles.drawerLinkPrimary}
            onClick={closeDrawer}
            delayMs={1000}
          >
            Dashboard
          </TransitionLink>
          <button type="button" onClick={handleSignOut} className={styles.drawerLinkSecondary}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isPending) {
      return (
        <>
          <TransitionLink
            href="/pending-approval"
            className={styles.drawerLinkSecondary}
            onClick={closeDrawer}
            delayMs={1000}
          >
            Application status
          </TransitionLink>
          <button type="button" onClick={handleSignOut} className={styles.drawerLinkSecondary}>
            Sign out
          </button>
        </>
      );
    }
    if (user && isRejected) {
      return (
        <>
          <span className={styles.drawerRejected}>Application not approved</span>
          <button type="button" onClick={handleSignOut} className={styles.drawerLinkPrimary}>
            Sign out
          </button>
        </>
      );
    }
    return (
      <>
        {/* delayMs waits ~1s — long enough for the drawer's 900ms close
            animation to fully complete (plus a 100ms beat) before the
            page transition begins. The user sees the drawer take its
            time, then the page transitions to the new route. */}
        <TransitionLink
          href="/login"
          className={styles.drawerLinkSecondary}
          onClick={closeDrawer}
          delayMs={1000}
        >
          Sign in
        </TransitionLink>
        <TransitionLink
          href="/register"
          className={styles.drawerLinkPrimary}
          onClick={closeDrawer}
          delayMs={1000}
        >
          Join as a UoN member
        </TransitionLink>
        {/* Separated external-collaborator path — plain link in the drawer
            (not a nested sheet) per the documented nested-portal gotcha. */}
        <TransitionLink
          href="/register?type=collaborator"
          className={styles.drawerLinkCollaborator}
          onClick={closeDrawer}
          delayMs={1000}
        >
          Collaborate with us (external)
        </TransitionLink>
      </>
    );
  };

  return (
    <>
      <header
        className={[
          styles.header,
          !entered ? styles.headerInitial : "",
          headerExiting ? styles.headerExiting : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
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
