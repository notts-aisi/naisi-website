"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import BrandMark from "@/components/BrandMark";
import Button from "@/components/ui/Button";
import Drawer from "@/components/ui/Drawer";
import { useAuth } from "@/auth/AuthProvider";
import { exitImpersonation } from "@/auth/impersonation";
import { signOut } from "@/auth/signInWithGoogle";
import { usePendingCount } from "@/features/admin/usePendingCount";
import type { UserPermissions } from "@/lib/firestore/users";
import { mark, warn } from "@/lib/devMonitor";
import { hardNavigate } from "@/lib/navigation/hardNavigate";
import { clearSelfHealAttempt } from "@/lib/navigation/selfHealGuard";
import styles from "./AppShell.module.css";

/** Banner state supplied by (app)/layout.tsx when a view-as session is live.
 *  `actorName` is who the real admin is; the target's identity is whatever
 *  `useAuth()` reports, so we only carry the actor side here. */
type Impersonation = {
  actorName: string;
  targetName: string;
  targetRole: string;
};

type Viewer = {
  role: "member" | "committee" | "admin";
  permissions: UserPermissions;
  suRecognised: boolean;
};
type NavItem = {
  label: string;
  href: string;
  visible: (v: Viewer) => boolean;
};
type NavGroup = {
  label: string | null;
  items: NavItem[];
};

const MEMBER_AND_UP = (v: Viewer) =>
  v.role === "member" || v.role === "committee" || v.role === "admin";
const COMMITTEE_AND_UP = (v: Viewer) => v.role === "committee" || v.role === "admin";
// The committee task board is for SU-recognised committee and admins only: it
// shows every committee task and the full member roster. Non-SU committee work
// from My Work and would only be redirected if they followed this link.
const SU_COMMITTEE_AND_UP = (v: Viewer) =>
  v.role === "admin" || (v.role === "committee" && v.suRecognised);
const ADMIN_ONLY = (v: Viewer) => v.role === "admin";
const NEWSLETTER_ACCESS = (v: Viewer) =>
  v.role === "admin" ||
  Boolean(v.permissions.draftNewsletter) ||
  Boolean(v.permissions.approveNewsletter);
// The events area is open to the whole committee, plus any member granted the
// draft or approve permission directly.
const EVENTS_ACCESS = (v: Viewer) =>
  v.role === "admin" ||
  v.role === "committee" ||
  Boolean(v.permissions.draftEvent) ||
  Boolean(v.permissions.approveEvent);

const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { label: "Dashboard", href: "/dashboard", visible: MEMBER_AND_UP },
      { label: "My work", href: "/tasks", visible: MEMBER_AND_UP },
      { label: "Profile", href: "/profile", visible: MEMBER_AND_UP },
    ],
  },
  {
    label: "Committee",
    items: [
      { label: "Task board", href: "/committee/tasks", visible: SU_COMMITTEE_AND_UP },
      { label: "Credentials", href: "/credentials", visible: COMMITTEE_AND_UP },
      { label: "Newsletter", href: "/newsletter", visible: NEWSLETTER_ACCESS },
      { label: "Events", href: "/events/manage", visible: EVENTS_ACCESS },
    ],
  },
  {
    label: "Admin",
    items: [{ label: "Admin", href: "/admin", visible: ADMIN_ONLY }],
  },
];

const NAV_DRAWER_ID = "app-nav-drawer";

export default function AppShell({
  children,
  impersonation,
}: {
  children: React.ReactNode;
  impersonation?: Impersonation | null;
}) {
  const pathname = usePathname();
  const { user, role, permissions, suRecognised, loading } = useAuth();
  const pendingCount = usePendingCount();
  const [exiting, setExiting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Fade the main content in once when we arrive from the sign-in flow.
  // Flag is set by login/register before router.push and consumed here.
  //
  // We start the content opacity-0 *immediately* on mount, but DELAY
  // the actual fade-in animation by ~280ms. That gives Firestore
  // onSnapshot listeners + initial role/permissions loads time to land
  // their first emit, so the content the user sees fade in is stable
  // rather than jittering as data populates mid-animation.
  const [enteringFromSignin, setEnteringFromSignin] = useState(false);
  useEffect(() => {
    try {
      // Reaching the app shell is proof any self-heal worked, so release the
      // one-shot reload guard — otherwise the next legitimate self-heal within
      // the window would be suppressed.
      clearSelfHealAttempt();
      if (sessionStorage.getItem("naisi:from-signin") === "1") {
        sessionStorage.removeItem("naisi:from-signin");
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEnteringFromSignin(true);
        // CSS handles the 280ms delay + 620ms animation; remove the
        // class once it's done so subsequent navigations don't pay
        // the cost.
        const t = setTimeout(() => setEnteringFromSignin(false), 280 + 620 + 80);
        return () => clearTimeout(t);
      }
    } catch {
      // sessionStorage unavailable (e.g. private mode iframe) — skip the fade
    }
  }, []);

  // Desktop sidebar collapse. Persisted to localStorage (kept out of cookies
  // to sidestep PECR's preference-cookie gray area). Default open; reloads
  // with a saved-collapsed state will briefly show the sidebar before sliding
  // it out — acceptable since the authed area isn't reload-heavy.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("naisi.sidebar.collapsed");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "true") setSidebarCollapsed(true);
    } catch {
      // localStorage unavailable (private mode etc.) — keep default
    }
  }, []);
  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("naisi.sidebar.collapsed", String(next));
      } catch {
        // Persistence best-effort; UI state still toggles
      }
      return next;
    });
  }

  // [monitor] Track AppShell lifecycle. The "stays-on-/login" symptom can
  // show up here as either (a) AppShell mounts on the destination but
  // loading never flips to false, or (b) AppShell never mounts at all
  // because the server-side layout redirected back to /login. Both are
  // distinguishable from these logs combined with the login page's own.
  const prevPathname = useRef(pathname);
  const prevLoading = useRef(loading);
  useEffect(() => {
    mark("[shell] mount/render", { pathname, loading, role });
  }, [pathname, loading, role]);

  useEffect(() => {
    if (prevPathname.current !== pathname) {
      mark(`[shell] pathname ${prevPathname.current} → ${pathname}`);
      prevPathname.current = pathname;
    }
  }, [pathname]);

  useEffect(() => {
    if (prevLoading.current !== loading) {
      mark(`[shell] loading ${prevLoading.current} → ${loading}`);
      prevLoading.current = loading;
    }
  }, [loading]);

  // Watchdog: if the skeleton sits up for >5s on this pathname, something
  // upstream (AuthProvider failsafe, Firestore snapshot) is wedged.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => {
      warn("[shell] still loading after 5s", { pathname, hasUser: !!user, role });
    }, 5000);
    return () => clearTimeout(t);
  }, [loading, pathname, user, role]);

  // Close the mobile drawer whenever the route changes. Catches back-button
  // navigations and any other path change not initiated by a drawer link tap
  // (links also call setDrawerOpen(false) on click, this is the safety net).
  // The set-state-in-effect rule doesn't apply cleanly here — we're reacting
  // to an external router state change but pathname doesn't expose a
  // subscribe API the way useSyncExternalStore expects.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false);
  }, [pathname]);

  async function handleExitImpersonation() {
    setExiting(true);
    try {
      await exitImpersonation();
      // No setExiting(false) on success — full-page nav to /login.
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Exit failed");
      setExiting(false);
    }
  }

  const visibleGroups =
    role === "admin" || role === "committee" || role === "member"
      ? NAV_GROUPS.map((g) => ({
          ...g,
          items: g.items.filter((item) =>
            item.visible({ role, permissions, suRecognised }),
          ),
        })).filter((g) => g.items.length > 0)
      : [];

  // Slide the entire app shell off to the right when signing out, in
  // mirror of the sign-in slide-left. The public homepage then fades in
  // from the left thanks to the sessionStorage flag set just before
  // signOut. Sequence: flag → close drawer (if open) → slide → signOut → push.
  //
  // The mobile drawer portals to <body>, so it isn't a descendant of
  // our slide wrapper — if it's still open when the slide starts, the
  // shell slides off but the drawer stays put, "depopulating" the rest
  // of the UI. Close the drawer first and let its own close animation
  // play before the wrapper slides.
  const [signoutExiting, setSignoutExiting] = useState(false);
  const SIGNOUT_SLIDE_MS = 530;
  /** Drawer panel transition is 900ms (Drawer.module.css). Wait that
   *  long on signout from the mobile drawer so the close fully lands
   *  before the shell starts sliding right. */
  const DRAWER_CLOSE_MS = 900;
  async function handleSignOut() {
    try {
      sessionStorage.setItem("naisi:from-signout", "1");
    } catch {
      /* sessionStorage may be unavailable — public layout falls back to no fade */
    }
    if (drawerOpen) {
      setDrawerOpen(false);
      await new Promise((r) => setTimeout(r, DRAWER_CLOSE_MS));
    }
    setSignoutExiting(true);
    await new Promise((r) => setTimeout(r, SIGNOUT_SLIDE_MS));
    await signOut();
    // Hard nav: the session cookie is now cleared, but this document still
    // holds authed RSC payloads in the segment cache and an authed tree in the
    // bfcache. A soft push would leave both reachable. The slide-out has
    // already finished, and "naisi:from-signout" is sessionStorage, so the
    // public layout's fade still fires. See lib/navigation/hardNavigate.ts.
    hardNavigate("/");
  }

  // Shared nav body — rendered both inside the desktop sidebar and inside
  // the mobile drawer so role-conditional rules and the pending-count
  // badge stay single-sourced.
  const renderNav = (onLinkClick?: () => void): ReactNode => (
    <nav className={styles.nav}>
      {visibleGroups.map((group, gi) => (
        <div
          key={group.label ?? `group-${gi}`}
          className={`${styles.navGroup} ${gi === 0 ? "" : styles.navGroupSpaced}`}
        >
          {group.label && <div className={styles.navGroupLabel}>{group.label}</div>}
          {group.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const showBadge = item.href === "/admin" && pendingCount > 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navLink} ${active ? styles.active : ""}`}
                onClick={onLinkClick}
              >
                <span>{item.label}</span>
                {showBadge && <span className={styles.navBadge}>{pendingCount}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const renderUserBlock = (): ReactNode => (
    <div className={styles.userBlock}>
      <div className={styles.userName}>
        {user?.displayName ?? user?.email ?? "Signed in"}
      </div>
      {role && <div className={styles.userRole}>{role}</div>}
      <Button
        variant="secondary"
        size="md"
        fullWidth
        onClick={handleSignOut}
        className={styles.signOut}
      >
        Sign out
      </Button>
    </div>
  );

  // Gate the entire authed UI on auth+role+permissions being ready. Otherwise
  // on a fresh navigation the server-rendered HTML (which has full auth context
  // via getCurrentUser in the layout) hydrates against a client AuthProvider
  // that starts with {loading: true}, causing children to briefly render with
  // stale/empty permissions. Flash shows up as nav items popping in, or
  // permission-gated content appearing and disappearing.
  if (loading) {
    return (
      <>
        <div className={styles.topStrip} aria-hidden>
          <div className={styles.topStripBrand}>
            <BrandMark size={28} />
          </div>
        </div>
        <div className={styles.shell}>
          <aside className={styles.sidebar} aria-label="Primary">
            <div className={styles.brand}>
              <BrandMark size={28} />
            </div>
            <nav className={styles.nav} aria-hidden>
              {[...Array(4)].map((_, i) => (
                <div key={i} className={styles.navSkeleton} />
              ))}
            </nav>
          </aside>
          <main
            className={`${styles.main} ${pathname === "/committee/tasks" ? styles.mainWide : ""}`}
          >
            <div className={styles.loadingPane} role="status" aria-live="polite">
              <span className={styles.spinner} aria-hidden />
              <span className={styles.loadingText}>Loading your workspace…</span>
            </div>
          </main>
        </div>
      </>
    );
  }

  return (
    <div className={signoutExiting ? styles.shellExitingRight : undefined}>
      <div className={styles.topStrip}>
        <Link href="/" className={styles.topStripBrand} aria-label="NAISI home">
          <BrandMark size={28} />
        </Link>
        <button
          type="button"
          className={styles.hamburger}
          aria-label={drawerOpen ? "Close menu" : "Open menu"}
          aria-expanded={drawerOpen}
          aria-controls={NAV_DRAWER_ID}
          onClick={() => setDrawerOpen(true)}
        >
          <span className={styles.menuIcon} aria-hidden>
            <span />
            <span />
            <span />
          </span>
          {pendingCount > 0 && (
            <span
              className={styles.hamburgerBadge}
              aria-label={`${pendingCount} pending approval${pendingCount === 1 ? "" : "s"}`}
            >
              {pendingCount}
            </span>
          )}
        </button>
      </div>
      <div
        className={styles.shell}
        data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      >
        <aside
          id="app-sidebar"
          className={styles.sidebar}
          aria-label="Primary"
          aria-hidden={sidebarCollapsed || undefined}
          inert={sidebarCollapsed}
        >
          <div className={styles.brandRow}>
            <Link href="/" aria-label="NAISI home">
              <BrandMark size={28} />
            </Link>
            <button
              type="button"
              className={styles.sidebarHamburger}
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              aria-expanded={!sidebarCollapsed}
              aria-controls="app-sidebar"
            >
              <span className={styles.menuIcon} aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </button>
          </div>
          {renderNav()}
          {renderUserBlock()}
        </aside>
        <main
          className={`${styles.main} ${pathname === "/committee/tasks" ? styles.mainWide : ""} ${enteringFromSignin ? styles.entering : ""}`}
        >
          {impersonation && (
            <div
              className={styles.impersonationBanner}
              role="status"
              aria-live="polite"
            >
              <span className={styles.impersonationText}>
                <strong>Viewing as {impersonation.targetName}</strong>{" "}
                <span className={styles.impersonationRole}>
                  ({impersonation.targetRole})
                </span>
                <span className={styles.impersonationWarn}>
                  {" — "}any actions you take will be recorded as this member.
                </span>
              </span>
              <button
                type="button"
                onClick={handleExitImpersonation}
                disabled={exiting}
                className={styles.impersonationExit}
              >
                {exiting ? "Exiting…" : "Exit view-as"}
              </button>
            </div>
          )}
          {children}
        </main>
      </div>
      {/* Always rendered so the slide-in/out transition has an interpolation
          source. CSS hides the container (transform off-screen right) unless
          its sibling .shell is in the collapsed state. `inert` mirrors the
          visual hidden state so keyboard / screen readers can't reach the
          off-screen brand link or hamburger. */}
      <div
        className={styles.floatingControls}
        aria-hidden={!sidebarCollapsed || undefined}
        inert={!sidebarCollapsed}
      >
        <Link
          href="/"
          aria-label="NAISI home"
          className={styles.floatingBrandLink}
        >
          <BrandMark size={24} />
        </Link>
        <button
          type="button"
          className={styles.floatingHamburger}
          onClick={toggleSidebar}
          aria-label="Open sidebar"
          aria-expanded={!sidebarCollapsed}
          aria-controls="app-sidebar"
        >
          <span className={styles.menuIcon} aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </button>
      </div>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        id={NAV_DRAWER_ID}
        ariaLabel="App navigation"
        closeAboveRem={60}
      >
        <div className={styles.drawerBrand}>
          <BrandMark size={32} />
        </div>
        {renderNav(() => setDrawerOpen(false))}
        {renderUserBlock()}
      </Drawer>
    </div>
  );
}
