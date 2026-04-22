"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePendingCount } from "@/features/admin/usePendingCount";
import styles from "./AdminTabs.module.css";

const TABS = [
  { label: "Approvals", href: "/admin", match: (p: string) => p === "/admin" },
  { label: "Members", href: "/admin/members", match: (p: string) => p.startsWith("/admin/members") },
  { label: "Projects", href: "/admin/projects", match: (p: string) => p.startsWith("/admin/projects") },
  { label: "Newsletter", href: "/admin/newsletter", match: (p: string) => p.startsWith("/admin/newsletter") },
  { label: "Email designs", href: "/admin/email-designs", match: (p: string) => p.startsWith("/admin/email-designs") },
  { label: "Deliverability", href: "/admin/deliverability", match: (p: string) => p.startsWith("/admin/deliverability") },
  { label: "Task templates", href: "/admin/task-templates", match: (p: string) => p.startsWith("/admin/task-templates") },
];

export default function AdminTabs() {
  const pathname = usePathname();
  const pendingCount = usePendingCount();

  return (
    <nav className={styles.tabs} aria-label="Admin sections">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const showBadge = tab.href === "/admin" && pendingCount > 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`${styles.tab} ${active ? styles.active : ""}`}
          >
            <span>{tab.label}</span>
            {showBadge && <span className={styles.badge}>{pendingCount}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
