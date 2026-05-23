"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { maxWidth } from "@/theme/breakpoints";
import type { UserDoc } from "@/lib/firestore/users";
import styles from "./AssigneePicker.module.css";

export type PickerRole = "completer" | "reviewer";

type RoleFilter = "all" | "admin" | "committee" | "member";
const ROLE_FILTERS: RoleFilter[] = ["all", "admin", "committee", "member"];
const ROLE_FILTER_LABELS: Record<RoleFilter, string> = {
  all: "All",
  admin: "Admins",
  committee: "Committee",
  member: "Members",
};

type Props = {
  users: UserDoc[];
  selected: string[];
  onChange: (uids: string[]) => void;
  label?: string;
  max?: number;
  role?: PickerRole;
  /** When true, show a role-filter chip strip above the search input. */
  showRoleFilter?: boolean;
  /** Restrict the picker to a specific set of uids. Used on subtask-level
   *  pickers so assignees can only come from `task.completerUids` and
   *  reviewers only from `task.reviewerUids` — you can't accidentally drag
   *  a non-roster person onto a single subtask. When the set is empty,
   *  the picker renders an inert hint instead of an empty list. */
  limitToUids?: string[];
  /** Copy shown when `limitToUids` is an empty array (so the UI explains
   *  why the picker is empty rather than just being bare). */
  emptyLimitHint?: string;
  /** Stage 5 (2026-04-26): per-uid inline Notify button. Renders an
   *  optional ghost-style "Notify" affordance next to any selected chip
   *  whose uid appears here. Only the task-level Completers + Reviewers
   *  pickers thread these props through; subtask-level pickers ignore them
   *  (subtask self-add doesn't trigger the membership-email flow). */
  notifyableUids?: string[];
  onNotify?: (uid: string) => void;
  notifyBusyUids?: string[];
};

const ROLE_COPY: Record<PickerRole, { verb: string; countLabel: string }> = {
  completer: { verb: "assigned", countLabel: "completer" },
  reviewer: { verb: "reviewing", countLabel: "reviewer" },
};

export default function AssigneePicker({
  users,
  selected,
  onChange,
  label,
  max = 10,
  role = "completer",
  showRoleFilter = false,
  limitToUids,
  emptyLimitHint,
  notifyableUids,
  onNotify,
  notifyBusyUids,
}: Props) {
  const notifySet = useMemo(
    () => new Set(notifyableUids ?? []),
    [notifyableUids],
  );
  const notifyBusySet = useMemo(
    () => new Set(notifyBusyUids ?? []),
    [notifyBusyUids],
  );
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  // Below --bp-md the picker collapses to chips + an "Add / change people"
  // button by default. Tapping the button reveals the search + list inline.
  // On desktop the picker is always expanded — the sidebar's narrow column
  // is the right shape for the inline UI. matchMedia + useSyncExternalStore
  // matches the pattern Dropdown.tsx uses for its sheet-vs-popover gate.
  const mobileSubscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(maxWidth("md"));
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const isMobile = useSyncExternalStore(
    mobileSubscribe,
    () => window.matchMedia(maxWidth("md")).matches,
    () => false,
  );
  const [expanded, setExpanded] = useState(false);
  const showFullPicker = !isMobile || expanded;

  const limitSet = useMemo(
    () => (limitToUids ? new Set(limitToUids) : null),
    [limitToUids],
  );

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = users.filter((u) => {
      if (limitSet && !limitSet.has(u.uid)) return false;
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (term) {
        const hay = (u.displayName ?? u.email ?? u.uid).toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    matches.sort((a, b) => {
      const na = (a.displayName ?? a.email ?? a.uid).toLowerCase();
      const nb = (b.displayName ?? b.email ?? b.uid).toLowerCase();
      return na.localeCompare(nb);
    });
    return matches;
  }, [users, search, roleFilter, limitSet]);

  function toggle(uid: string) {
    if (selected.includes(uid)) {
      onChange(selected.filter((u) => u !== uid));
    } else {
      if (selected.length >= max) return;
      onChange([...selected, uid]);
    }
  }

  const selectedUsers = users.filter((u) => selected.includes(u.uid));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 }}>
      {label && (
        <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
          {label}
        </span>
      )}

      {selectedUsers.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {selectedUsers.map((u) => {
            const showNotify = onNotify && notifySet.has(u.uid);
            const notifyBusy = notifyBusySet.has(u.uid);
            return (
              <span
                key={u.uid}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                }}
              >
                <button
                  type="button"
                  onClick={() => toggle(u.uid)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "0.25rem 0.55rem",
                    borderRadius: "var(--radius-pill)",
                    background:
                      role === "reviewer"
                        ? "var(--color-warning-soft, var(--color-surface-hover))"
                        : "var(--color-accent-soft)",
                    color:
                      role === "reviewer"
                        ? "var(--color-warning, var(--color-text))"
                        : "var(--color-accent)",
                    fontSize: "var(--text-xs)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span>{u.displayName ?? u.email ?? u.uid}</span>
                  <span aria-hidden>✕</span>
                </button>
                {showNotify && (
                  <button
                    type="button"
                    onClick={() => onNotify!(u.uid)}
                    disabled={notifyBusy}
                    title={`Send the membership email to ${u.displayName ?? u.email ?? u.uid}.`}
                    style={{
                      padding: "0.2rem 0.55rem",
                      background: "transparent",
                      color: "var(--color-text-muted)",
                      border: "1px dashed var(--color-border)",
                      borderRadius: "var(--radius-pill)",
                      fontSize: "var(--text-xs)",
                      fontWeight: 500,
                      cursor: notifyBusy ? "not-allowed" : "pointer",
                      opacity: notifyBusy ? 0.6 : 1,
                    }}
                  >
                    {notifyBusy ? "Notifying…" : "Notify"}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {!showFullPicker && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={styles.expandButton}
        >
          {selectedUsers.length > 0
            ? `Change ${ROLE_COPY[role].countLabel}s…`
            : `Add ${ROLE_COPY[role].countLabel}s…`}
        </button>
      )}

      {showFullPicker && showRoleFilter && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
          {ROLE_FILTERS.map((rf) => {
            const active = roleFilter === rf;
            return (
              <button
                key={rf}
                type="button"
                onClick={() => setRoleFilter(rf)}
                style={{
                  padding: "0.2rem 0.6rem",
                  borderRadius: "var(--radius-pill)",
                  border: "1px solid var(--color-border)",
                  background: active ? "var(--color-accent-soft)" : "transparent",
                  color: active ? "var(--color-accent)" : "var(--color-text-muted)",
                  fontSize: "var(--text-xs)",
                  cursor: "pointer",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {ROLE_FILTER_LABELS[rf]}
              </button>
            );
          })}
        </div>
      )}

      {showFullPicker && (
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search people…"
        style={{
          padding: "0.55rem 0.75rem",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-text)",
          fontSize: "var(--text-sm)",
        }}
      />
      )}

      {showFullPicker && (
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg-elevated)",
          maxHeight: "12rem",
          overflowY: "auto",
        }}
      >
        {sorted.length === 0 && (
          <p
            style={{
              padding: "var(--space-3)",
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
            }}
          >
            {limitSet && limitSet.size === 0 && emptyLimitHint
              ? emptyLimitHint
              : "No matches."}
          </p>
        )}
        {sorted.map((u) => {
          const isSelected = selected.includes(u.uid);
          return (
            <label
              key={u.uid}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "0.45rem 0.75rem",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
                background: isSelected ? "var(--color-surface-hover)" : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggle(u.uid)}
              />
              <span>{u.displayName ?? u.email ?? u.uid}</span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: "var(--text-xs)",
                  color: "var(--color-text-subtle)",
                  textTransform: "capitalize",
                }}
              >
                {u.role}
              </span>
            </label>
          );
        })}
      </div>
      )}

      {showFullPicker && (
      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-subtle)" }}>
        {selected.length}/{max} {ROLE_COPY[role].verb}
      </span>
      )}

      {showFullPicker && isMobile && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className={styles.collapseLink}
        >
          Hide search
        </button>
      )}
    </div>
  );
}
