"use client";

import type { ChangeEvent } from "react";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import type { AffiliationStatus } from "@/lib/firestore/users";
import styles from "./MembersToolbar.module.css";

export type RoleFilter = "all" | "member" | "committee" | "admin" | "rejected";
export type StatusFilter = "all" | AffiliationStatus;
export type TrackFilter = "all" | "technical" | "governance" | "both" | "none";
export type NewsletterFilter = "all" | "draft" | "approve" | "none";

const ROLE_FILTERS: Array<{ value: RoleFilter; label: string }> = [
  { value: "all", label: "All active" },
  { value: "member", label: "Members" },
  { value: "committee", label: "Committee" },
  { value: "admin", label: "Admins" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All levels" },
  { value: "foundation", label: "Foundation" },
  { value: "undergraduate", label: "Undergraduate" },
  { value: "masters", label: "Masters" },
  { value: "phd", label: "PhD" },
  { value: "postdoc", label: "Postdoc" },
  { value: "employee", label: "Staff" },
  { value: "other", label: "Other" },
];

const TRACK_OPTIONS: Array<{ value: TrackFilter; label: string }> = [
  { value: "all", label: "Any track" },
  { value: "technical", label: "Technical" },
  { value: "governance", label: "Governance" },
  { value: "both", label: "Both tracks" },
  { value: "none", label: "Unassigned" },
];

const NEWSLETTER_OPTIONS: Array<{ value: NewsletterFilter; label: string }> = [
  { value: "all", label: "Any access" },
  { value: "draft", label: "Can draft" },
  { value: "approve", label: "Can approve + send" },
  { value: "none", label: "No access" },
];

type Props = {
  query: string;
  onQueryChange: (next: string) => void;
  roleFilter: RoleFilter;
  onRoleFilterChange: (next: RoleFilter) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (next: StatusFilter) => void;
  trackFilter: TrackFilter;
  onTrackFilterChange: (next: TrackFilter) => void;
  newsletterFilter: NewsletterFilter;
  onNewsletterFilterChange: (next: NewsletterFilter) => void;
  count: number;
};

export default function MembersToolbar({
  query,
  onQueryChange,
  roleFilter,
  onRoleFilterChange,
  statusFilter,
  onStatusFilterChange,
  trackFilter,
  onTrackFilterChange,
  newsletterFilter,
  onNewsletterFilterChange,
  count,
}: Props) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.search}
          placeholder="Search by name, email, university email, or title…"
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onQueryChange(e.target.value)}
          aria-label="Search members"
        />
        <span className={styles.count}>
          {count} match{count === 1 ? "" : "es"}
        </span>
      </div>
      <div className={styles.chips} role="tablist" aria-label="Filter by role">
        {ROLE_FILTERS.map((f) => {
          const active = roleFilter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={active}
              className={`${styles.chip} ${active ? styles.chipActive : ""}`}
              onClick={() => onRoleFilterChange(f.value)}
            >
              {f.label}
            </button>
          );
        })}
      </div>
      <div className={styles.selectRow}>
        <label className={styles.selectLabel}>
          <span>Level of studies</span>
          <ResponsiveSelect<StatusFilter>
            className={styles.select}
            value={statusFilter}
            onChange={onStatusFilterChange}
            options={STATUS_OPTIONS}
            ariaLabel="Level of studies"
          />
        </label>
        <label className={styles.selectLabel}>
          <span>Track</span>
          <ResponsiveSelect<TrackFilter>
            className={styles.select}
            value={trackFilter}
            onChange={onTrackFilterChange}
            options={TRACK_OPTIONS}
            ariaLabel="Track"
          />
        </label>
        <label className={styles.selectLabel}>
          <span>Newsletter</span>
          <ResponsiveSelect<NewsletterFilter>
            className={styles.select}
            value={newsletterFilter}
            onChange={onNewsletterFilterChange}
            options={NEWSLETTER_OPTIONS}
            ariaLabel="Newsletter"
          />
        </label>
      </div>
    </div>
  );
}
