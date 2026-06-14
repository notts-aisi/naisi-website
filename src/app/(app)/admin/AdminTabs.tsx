"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { usePendingCount } from "@/features/admin/usePendingCount";
import { useCollaboratorCount } from "@/features/admin/useCollaboratorCount";
import styles from "./AdminTabs.module.css";

const TABS = [
  { label: "Approvals", href: "/admin", match: (p: string) => p === "/admin" },
  { label: "Members", href: "/admin/members", match: (p: string) => p.startsWith("/admin/members") },
  { label: "Collaborators", href: "/admin/collaborators", match: (p: string) => p.startsWith("/admin/collaborators") },
  { label: "Projects", href: "/admin/projects", match: (p: string) => p.startsWith("/admin/projects") },
  { label: "Newsletter", href: "/admin/newsletter", match: (p: string) => p.startsWith("/admin/newsletter") },
  { label: "Subscriptions", href: "/admin/subscriptions", match: (p: string) => p.startsWith("/admin/subscriptions") },
  { label: "Email designs", href: "/admin/email-designs", match: (p: string) => p.startsWith("/admin/email-designs") },
  { label: "Deliverability", href: "/admin/deliverability", match: (p: string) => p.startsWith("/admin/deliverability") },
  { label: "Task templates", href: "/admin/task-templates", match: (p: string) => p.startsWith("/admin/task-templates") },
  // TEMP — fire-once data-wipe controls. Remove this entry along with
  // `src/app/(app)/admin/danger-zone/` and `src/app/api/admin/nuke-tasks/`
  // once both environments have been reset.
  { label: "Danger zone", href: "/admin/danger-zone", match: (p: string) => p.startsWith("/admin/danger-zone") },
];

export default function AdminTabs() {
  const pathname = usePathname();
  const pendingCount = usePendingCount();
  const collaboratorCount = useCollaboratorCount();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // On mobile the tab strip scrolls horizontally — pull the active tab into
  // view so users landing on a deep tab (e.g. /admin/danger-zone) don't have
  // to swipe through the strip to find where they are.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  return (
    <nav className={styles.tabs} aria-label="Admin sections">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const badgeCount =
          tab.href === "/admin"
            ? pendingCount
            : tab.href === "/admin/collaborators"
              ? collaboratorCount
              : 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            ref={active ? activeRef : undefined}
            className={`${styles.tab} ${active ? styles.active : ""}`}
          >
            <span>{tab.label}</span>
            {badgeCount > 0 && <span className={styles.badge}>{badgeCount}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
