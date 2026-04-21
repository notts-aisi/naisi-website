"use client";

import { useMemo, useState } from "react";
import type { UserDoc } from "@/lib/firestore/users";

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
}: Props) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = users.filter((u) => {
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
  }, [users, search, roleFilter]);

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
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {label && (
        <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
          {label}
        </span>
      )}

      {selectedUsers.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {selectedUsers.map((u) => (
            <button
              key={u.uid}
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
          ))}
        </div>
      )}

      {showRoleFilter && (
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
            No matches.
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
      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-subtle)" }}>
        {selected.length}/{max} {ROLE_COPY[role].verb}
      </span>
    </div>
  );
}
