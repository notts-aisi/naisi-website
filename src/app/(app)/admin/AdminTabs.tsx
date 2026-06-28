"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Drawer from "@/components/ui/Drawer";
import { usePendingCount } from "@/features/admin/usePendingCount";
import { useCollaboratorCount } from "@/features/admin/useCollaboratorCount";
import styles from "./AdminTabs.module.css";

const TABS = [
  { label: "Approvals", href: "/admin", match: (p: string) => p === "/admin" },
  { label: "Members", href: "/admin/members", match: (p: string) => p.startsWith("/admin/members") },
  { label: "Collaborators", href: "/admin/collaborators", match: (p: string) => p.startsWith("/admin/collaborators") },
  { label: "Registrations", href: "/admin/registrations", match: (p: string) => p.startsWith("/admin/registrations") },
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");

  const badgeFor = (href: string): number =>
    href === "/admin"
      ? pendingCount
      : href === "/admin/collaborators"
        ? collaboratorCount
        : 0;

  // On the horizontal strip (desktop/tablet) pull the active tab into view so
  // users landing on a deep tab don't have to scroll the strip to find it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  // Close the mobile picker (and reset its filter) once navigation lands on a new
  // route. Render-phase derived reset (not a setState-in-effect) — matches the
  // pattern in Dropdown.tsx.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (menuOpen) setMenuOpen(false);
    if (query) setQuery("");
  }

  const activeTab = TABS.find((t) => t.match(pathname)) ?? TABS[0];
  const activeBadge = badgeFor(activeTab.href);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? TABS.filter((t) => t.label.toLowerCase().includes(q)) : TABS;
  }, [query]);

  return (
    <>
      {/* Desktop / tablet: the horizontal strip (scrolls internally — see CSS). */}
      <nav className={styles.tabs} aria-label="Admin sections">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          const badgeCount = badgeFor(tab.href);
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

      {/* Phone: a single picker button that opens a searchable section sheet. */}
      <button
        type="button"
        className={styles.mobileTrigger}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-controls="admin-section-menu"
        onClick={() => setMenuOpen(true)}
      >
        <span className={styles.mobileTriggerLabel}>
          <span className={styles.mobileTriggerHint}>Admin section</span>
          <span className={styles.mobileTriggerValue}>{activeTab.label}</span>
        </span>
        {activeBadge > 0 && <span className={styles.badge}>{activeBadge}</span>}
        <svg className={styles.mobileChevron} viewBox="0 0 12 8" aria-hidden="true">
          <path
            d="M1 1.5L6 6.5L11 1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <Drawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        id="admin-section-menu"
        ariaLabel="Admin sections"
      >
        <div className={styles.sheet}>
          <div className={styles.sheetHead}>
            <h2 className={styles.sheetTitle}>Admin sections</h2>
            <button
              type="button"
              className={styles.sheetClose}
              onClick={() => setMenuOpen(false)}
              aria-label="Close section menu"
            >
              ✕
            </button>
          </div>
          <input
            type="search"
            className={styles.sheetSearch}
            placeholder="Search sections…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search admin sections"
            autoComplete="off"
          />
          <ul className={styles.sheetList}>
            {filtered.map((tab) => {
              const active = tab.match(pathname);
              const badgeCount = badgeFor(tab.href);
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    className={`${styles.sheetItem} ${active ? styles.sheetItemActive : ""}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    <span>{tab.label}</span>
                    {badgeCount > 0 && <span className={styles.badge}>{badgeCount}</span>}
                  </Link>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className={styles.sheetEmpty}>No sections match “{query.trim()}”.</li>
            )}
          </ul>
        </div>
      </Drawer>
    </>
  );
}
