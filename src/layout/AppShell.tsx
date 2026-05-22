"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import BrandMark from "@/components/BrandMark";
import { useAuth } from "@/auth/AuthProvider";
import { exitImpersonation } from "@/auth/impersonation";
import { signOut } from "@/auth/signInWithGoogle";
import { usePendingCount } from "@/features/admin/usePendingCount";
import type { UserPermissions } from "@/lib/firestore/users";
import { mark, warn } from "@/lib/devMonitor";
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

export default function AppShell({
  children,
  impersonation,
}: {
  children: React.ReactNode;
  impersonation?: Impersonation | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, role, permissions, suRecognised, loading } = useAuth();
  const pendingCount = usePendingCount();
  const [exiting, setExiting] = useState(false);

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

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  // Gate the entire authed UI on auth+role+permissions being ready. Otherwise
  // on a fresh navigation the server-rendered HTML (which has full auth context
  // via getCurrentUser in the layout) hydrates against a client AuthProvider
  // that starts with {loading: true}, causing children to briefly render with
  // stale/empty permissions. Flash shows up as nav items popping in, or
  // permission-gated content appearing and disappearing.
  if (loading) {
    return (
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
        <main className={styles.main}>
          <div className={styles.loadingPane} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden />
            <span className={styles.loadingText}>Loading your workspace…</span>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Primary">
        <div className={styles.brand}>
          <Link href="/" aria-label="NAISI home">
            <BrandMark size={28} />
          </Link>
        </div>
        <nav className={styles.nav}>
          {visibleGroups.map((group, gi) => (
            <div
              key={group.label ?? `group-${gi}`}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", marginTop: gi === 0 ? 0 : "var(--space-3)" }}
            >
              {group.label && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--color-text-subtle)",
                    padding: "0 var(--space-3)",
                    marginBottom: "var(--space-1)",
                  }}
                >
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const showBadge = item.href === "/admin" && pendingCount > 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.navLink} ${active ? styles.active : ""}`}
                  >
                    <span>{item.label}</span>
                    {showBadge && <span className={styles.navBadge}>{pendingCount}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className={styles.userBlock}>
          <div style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>
            {user?.displayName ?? user?.email ?? "Signed in"}
          </div>
          {role && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", textTransform: "capitalize" }}>
              {role}
            </div>
          )}
          <button onClick={handleSignOut} className={styles.signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className={styles.main}>
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
  );
}
