"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Drawer from "@/components/ui/Drawer";
import { usePendingCount } from "@/features/admin/usePendingCount";
import { useCollaboratorCount } from "@/features/admin/useCollaboratorCount";
import { useCourseApplicationCount } from "@/features/courses/useCourseApplicationCount";
import styles from "./AdminTabs.module.css";

/**
 * What the caller may reach, resolved once by the server layout.
 *
 * Four capabilities rather than one `isAdmin` boolean, because the admin area
 * now has three audiences with three different gates: full admins, course
 * permission holders (`/admin/courses`), and round authors or appointed
 * reviewers (`/admin/admissions`). A tab a caller cannot open is a link that
 * redirects to the dashboard, so the strip has to know the same predicates the
 * page gates do.
 */
export type AdminTabAccess = {
  isAdmin: boolean;
  /** `draftCourse` or `approveCourse`: the course authoring tree. */
  canAuthorCourses: boolean;
  /** `approveCourse`: authoring an admission round. */
  canAuthorRounds: boolean;
  /** Appointed on some round. Reads its own round, writes nothing. */
  isAdmissionsReviewer: boolean;
  /** `manageMembership`: periods, tier grants and the membership console. */
  canManageMembership: boolean;
};

type AdminTab = {
  label: string;
  href: string;
  match: (p: string) => boolean;
  /** Who may open this section. Mirrors the page gate, never a looser rule. */
  visible: (access: AdminTabAccess) => boolean;
};

const ADMIN_ONLY = (a: AdminTabAccess) => a.isAdmin;

const TABS: AdminTab[] = [
  { label: "Approvals", href: "/admin", match: (p: string) => p === "/admin", visible: ADMIN_ONLY },
  // Exact-or-child rather than a prefix: "/admin/membership" starts with
  // "/admin/members", so a plain prefix test would light the Members tab up on
  // the membership console and, since the strip picks the first match, leave
  // Membership looking inactive on its own page.
  { label: "Members", href: "/admin/members", match: (p: string) => p === "/admin/members" || p.startsWith("/admin/members/"), visible: ADMIN_ONLY },
  { label: "Collaborators", href: "/admin/collaborators", match: (p: string) => p.startsWith("/admin/collaborators"), visible: ADMIN_ONLY },
  { label: "Registrations", href: "/admin/registrations", match: (p: string) => p.startsWith("/admin/registrations"), visible: ADMIN_ONLY },
  { label: "Projects", href: "/admin/projects", match: (p: string) => p.startsWith("/admin/projects"), visible: ADMIN_ONLY },
  { label: "Courses", href: "/admin/courses", match: (p: string) => p.startsWith("/admin/courses"), visible: (a) => a.isAdmin || a.canAuthorCourses },
  { label: "Admissions", href: "/admin/admissions", match: (p: string) => p.startsWith("/admin/admissions"), visible: (a) => a.isAdmin || a.canAuthorRounds || a.isAdmissionsReviewer },
  { label: "Membership", href: "/admin/membership", match: (p: string) => p.startsWith("/admin/membership"), visible: (a) => a.isAdmin || a.canManageMembership },
  { label: "Newsletter", href: "/admin/newsletter", match: (p: string) => p.startsWith("/admin/newsletter"), visible: ADMIN_ONLY },
  { label: "Subscriptions", href: "/admin/subscriptions", match: (p: string) => p.startsWith("/admin/subscriptions"), visible: ADMIN_ONLY },
  { label: "Email designs", href: "/admin/email-designs", match: (p: string) => p.startsWith("/admin/email-designs"), visible: ADMIN_ONLY },
  { label: "Deliverability", href: "/admin/deliverability", match: (p: string) => p.startsWith("/admin/deliverability"), visible: ADMIN_ONLY },
  { label: "Task templates", href: "/admin/task-templates", match: (p: string) => p.startsWith("/admin/task-templates"), visible: ADMIN_ONLY },
  { label: "Site status", href: "/admin/site-status", match: (p: string) => p.startsWith("/admin/site-status"), visible: ADMIN_ONLY },
  // TEMP — fire-once data-wipe controls. Remove this entry along with
  // `src/app/(app)/admin/(admin-only)/danger-zone/` and
  // `src/app/api/admin/nuke-tasks/` once both environments have been reset.
  { label: "Danger zone", href: "/admin/danger-zone", match: (p: string) => p.startsWith("/admin/danger-zone"), visible: ADMIN_ONLY },
];

/**
 * The tab strip for the admin area.
 *
 * `access` comes from the server layout, which has already read the session, so
 * the strip stays in step with the gates that actually decide
 * (`requireAdminPage()`, `requireCourseAuthorPage()`,
 * `requireAdmissionsPage()`) instead of being a second client-side opinion that
 * could drift from them. Every tab renders only for the callers its own page
 * would let in.
 */
export default function AdminTabs({ access }: { access: AdminTabAccess }) {
  const pathname = usePathname();
  const pendingCount = usePendingCount();
  const collaboratorCount = useCollaboratorCount();
  const courseApplicationCount = useCourseApplicationCount();
  const activeRef = useRef<HTMLAnchorElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");

  const tabs = useMemo(() => TABS.filter((tab) => tab.visible(access)), [access]);

  // `?? 0` for courses: that hook reports an unknown count as null (see its
  // doc comment), and a badge that hasn't been measured renders as no badge.
  const badgeFor = (href: string): number =>
    href === "/admin"
      ? pendingCount
      : href === "/admin/collaborators"
        ? collaboratorCount
        : href === "/admin/courses"
          ? (courseApplicationCount ?? 0)
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

  const activeTab = tabs.find((t) => t.match(pathname)) ?? tabs[0];
  const activeBadge = activeTab ? badgeFor(activeTab.href) : 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tabs.filter((t) => t.label.toLowerCase().includes(q)) : tabs;
  }, [query, tabs]);

  return (
    <>
      {/* Desktop / tablet: the horizontal strip (scrolls internally — see CSS). */}
      <nav className={styles.tabs} aria-label="Admin sections">
        {tabs.map((tab) => {
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
          <span className={styles.mobileTriggerValue}>{activeTab?.label ?? "Admin"}</span>
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
