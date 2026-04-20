"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import BrandMark from "@/components/BrandMark";
import { useAuth } from "@/auth/AuthProvider";
import { signOut } from "@/auth/signInWithGoogle";
import { usePendingCount } from "@/features/admin/usePendingCount";
import type { UserPermissions } from "@/lib/firestore/users";
import styles from "./AppShell.module.css";

type Viewer = { role: "member" | "committee" | "admin"; permissions: UserPermissions };
type NavItem = {
  label: string;
  href: string;
  visible: (v: Viewer) => boolean;
};

const MEMBER_AND_UP = (v: Viewer) =>
  v.role === "member" || v.role === "committee" || v.role === "admin";
const COMMITTEE_AND_UP = (v: Viewer) => v.role === "committee" || v.role === "admin";
const ADMIN_ONLY = (v: Viewer) => v.role === "admin";
const NEWSLETTER_ACCESS = (v: Viewer) =>
  v.role === "admin" ||
  Boolean(v.permissions.draftNewsletter) ||
  Boolean(v.permissions.approveNewsletter);

const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", visible: MEMBER_AND_UP },
  { label: "Tasks", href: "/tasks", visible: MEMBER_AND_UP },
  { label: "Calendar", href: "/calendar", visible: MEMBER_AND_UP },
  { label: "Profile", href: "/profile", visible: MEMBER_AND_UP },
  { label: "Newsletter", href: "/newsletter", visible: NEWSLETTER_ACCESS },
  { label: "Credentials", href: "/credentials", visible: COMMITTEE_AND_UP },
  { label: "Admin", href: "/admin", visible: ADMIN_ONLY },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, role, permissions, loading } = useAuth();
  const pendingCount = usePendingCount();

  const visible =
    role === "admin" || role === "committee" || role === "member"
      ? NAV.filter((item) => item.visible({ role, permissions }))
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
          {visible.map((item) => {
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
      <main className={styles.main}>{children}</main>
    </div>
  );
}
