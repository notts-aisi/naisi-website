"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { maxWidth } from "@/theme/breakpoints";
import type { UserDoc } from "@/lib/firestore/users";
import styles from "./PersonSelector.module.css";

/**
 * Sitewide multi-select for users. The shape every "pick people" surface
 * in the app uses: chip strip of selected users, optional role-filter
 * strip, search input, capped result list, count caption.
 *
 * - `role` carries the semantic (completer / reviewer) used for the
 *   count-caption verb ("assigned" vs "reviewing"). Independent of chip
 *   colour.
 * - `tone` picks the chip palette (accent / warning / neutral). Defaults
 *   from `role` so existing task callsites stay byte-for-byte equivalent;
 *   pass `tone="neutral"` for project-membership-style use where the
 *   "completer" verb would lie.
 * - Below `--bp-md` the picker collapses to chips + an "Add / change…"
 *   button. Tapping it opens a portal-rendered bottom sheet (scrim +
 *   slide-up panel + scroll-locked body) mirroring Dropdown.tsx's sheet
 *   pattern. Desktop stays inline-expanded (the sidebar is a narrow
 *   column and the inline shape is the right fit).
 */

export type PersonRole = "completer" | "reviewer";
export type PersonTone = "accent" | "warning" | "neutral";

type RoleFilter = "all" | "admin" | "committee" | "member";
const ROLE_FILTERS: RoleFilter[] = ["all", "admin", "committee", "member"];
const ROLE_FILTER_LABELS: Record<RoleFilter, string> = {
  all: "All",
  admin: "Admins",
  committee: "Committee",
  member: "Members",
};

const ROLE_COPY: Record<PersonRole, { verb: string; countLabel: string }> = {
  completer: { verb: "assigned", countLabel: "completer" },
  reviewer: { verb: "reviewing", countLabel: "reviewer" },
};

const TONE_FROM_ROLE: Record<PersonRole, PersonTone> = {
  completer: "accent",
  reviewer: "warning",
};

type Props = {
  users: UserDoc[];
  selected: string[];
  onChange: (uids: string[]) => void;
  label?: string;
  max?: number;
  role?: PersonRole;
  /** Chip palette. Defaults from `role` (completer → accent, reviewer →
   *  warning). Pass "neutral" for callsites where role-as-verb doesn't
   *  apply (e.g. admin project membership). */
  tone?: PersonTone;
  /** Show the All / Admins / Committee / Members filter strip above the
   *  search input. Admin Projects uses this. */
  showRoleFilter?: boolean;
  /** Restrict the picker to a specific set of uids. Subtask-level
   *  pickers use this so per-subtask membership is bounded by the
   *  task's completers / reviewers. */
  limitToUids?: string[];
  /** Copy shown when `limitToUids` is empty (so the UI explains the
   *  empty state instead of just being bare). */
  emptyLimitHint?: string;
  /** Optional per-uid inline "Notify" button next to each selected chip
   *  whose uid appears here. Only task-level Completers + Reviewers in
   *  TaskDetailModal pass these; everything else ignores them. */
  notifyableUids?: string[];
  onNotify?: (uid: string) => void;
  notifyBusyUids?: string[];
};

export default function PersonSelector({
  users,
  selected,
  onChange,
  label,
  max = 10,
  role = "completer",
  tone,
  showRoleFilter = false,
  limitToUids,
  emptyLimitHint,
  notifyableUids,
  onNotify,
  notifyBusyUids,
}: Props) {
  const effectiveTone: PersonTone = tone ?? TONE_FROM_ROLE[role];
  const chipClass = [
    styles.chip,
    effectiveTone === "warning" ? styles.chipReviewer : "",
    effectiveTone === "neutral" ? styles.chipNeutral : "",
  ]
    .filter(Boolean)
    .join(" ");

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

  // Mobile gate. Below --bp-md the picker collapses to chips + an
  // "Add / change…" button; tapping opens the bottom sheet (portal +
  // scrim + slide-up panel). Mirrors Dropdown.tsx's sheet-vs-popover gate.
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

  // Body scroll-lock while the mobile sheet is open. Same pattern as
  // Drawer.tsx — the cleanup restores the previous overflow value so we
  // don't stomp on whatever the parent had set.
  useEffect(() => {
    if (!isMobile || !expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isMobile, expanded]);

  function renderChips() {
    if (selectedUsers.length === 0) return null;
    return (
      <div className={styles.chips}>
        {selectedUsers.map((u) => {
          const showNotify = onNotify && notifySet.has(u.uid);
          const notifyBusy = notifyBusySet.has(u.uid);
          return (
            <span key={u.uid} className={styles.chipWrap}>
              <button
                type="button"
                onClick={() => toggle(u.uid)}
                className={chipClass}
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
                  className={styles.notifyBtn}
                >
                  {notifyBusy ? "Notifying…" : "Notify"}
                </button>
              )}
            </span>
          );
        })}
      </div>
    );
  }

  // Picker controls shared between desktop inline render and mobile sheet.
  function renderPickerControls() {
    return (
      <>
        {showRoleFilter && (
          <div className={styles.filterRow}>
            {ROLE_FILTERS.map((rf) => {
              const active = roleFilter === rf;
              return (
                <button
                  key={rf}
                  type="button"
                  onClick={() => setRoleFilter(rf)}
                  className={
                    active
                      ? `${styles.filterChip} ${styles.filterChipActive}`
                      : styles.filterChip
                  }
                >
                  {ROLE_FILTER_LABELS[rf]}
                </button>
              );
            })}
          </div>
        )}

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search people…"
          className={styles.search}
        />

        <div className={styles.list}>
          {sorted.length === 0 && (
            <p className={styles.listEmpty}>
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
                className={
                  isSelected
                    ? `${styles.listRow} ${styles.listRowSelected}`
                    : styles.listRow
                }
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(u.uid)}
                />
                <span>{u.displayName ?? u.email ?? u.uid}</span>
                <span className={styles.listRoleHint}>{u.role}</span>
              </label>
            );
          })}
        </div>

        <span className={styles.countCaption}>
          {selected.length}/{max} {ROLE_COPY[role].verb}
        </span>
      </>
    );
  }

  return (
    <div className={styles.root}>
      {label && <span className={styles.label}>{label}</span>}

      {renderChips()}

      {/* Mobile collapsed state: chips above + "Change…" button.
          Desktop renders the inline picker controls instead. */}
      {isMobile ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={styles.expandButton}
        >
          {selectedUsers.length > 0
            ? `Change ${ROLE_COPY[role].countLabel}s…`
            : `Add ${ROLE_COPY[role].countLabel}s…`}
        </button>
      ) : (
        renderPickerControls()
      )}

      {/* Mobile expanded state: portal-rendered bottom sheet with scrim +
          slide-up panel + scroll-locked body. The `typeof document` guard
          is belt-and-braces (useSyncExternalStore's server snapshot makes
          isMobile false during SSR anyway). */}
      {isMobile && expanded && typeof document !== "undefined" &&
        createPortal(
          <div className={styles.sheetRoot}>
            <div
              className={styles.scrim}
              onClick={(e) => {
                // Close on click (not pointerdown) — matches Dropdown.tsx's
                // sheet scrim behaviour so iOS doesn't re-target the
                // synthetic click to the trigger underneath.
                e.stopPropagation();
                setExpanded(false);
              }}
            />
            <div
              className={styles.sheet}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.sheetHandle} aria-hidden />
              <div className={styles.sheetHeader}>
                <h3 className={styles.sheetTitle}>
                  {selectedUsers.length > 0
                    ? `Change ${ROLE_COPY[role].countLabel}s`
                    : `Add ${ROLE_COPY[role].countLabel}s`}
                </h3>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label="Close picker"
                  className={styles.sheetCloseIcon}
                >
                  ✕
                </button>
              </div>
              {/* Repeat the chips inside the sheet so the user can
                  deselect from here without dismissing back to the
                  collapsed state. */}
              {renderChips()}
              {renderPickerControls()}
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className={styles.doneButton}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
