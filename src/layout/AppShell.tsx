"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import BrandMark from "@/components/BrandMark";
import { useAuth } from "@/auth/AuthProvider";
import { signOut } from "@/auth/signInWithGoogle";
import { usePendingCount } from "@/features/admin/usePendingCount";
import styles from "./AppShell.module.css";

type NavItem = { label: string; href: string; roles: Array<"member" | "committee" | "admin"> };

const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", roles: ["member", "committee", "admin"] },
  { label: "Tasks", href: "/tasks", roles: ["member", "committee", "admin"] },
  { label: "Calendar", href: "/calendar", roles: ["member", "committee", "admin"] },
  { label: "Vault", href: "/vault", roles: ["committee", "admin"] },
  { label: "Admin", href: "/admin", roles: ["admin"] },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, role } = useAuth();
  const pendingCount = usePendingCount();

  const visible = NAV.filter(
    (item) =>
      role === "admin" ||
      (role && item.roles.includes(role as "member" | "committee" | "admin")),
  );

  async function handleSignOut() {
    await signOut();
    router.push("/");
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
