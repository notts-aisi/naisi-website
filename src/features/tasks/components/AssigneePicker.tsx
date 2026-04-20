"use client";

import { useMemo, useState } from "react";
import type { UserDoc } from "@/lib/firestore/users";

type Props = {
  users: UserDoc[];
  selected: string[];
  onChange: (uids: string[]) => void;
  label?: string;
  max?: number;
};

export default function AssigneePicker({ users, selected, onChange, label, max = 10 }: Props) {
  const [search, setSearch] = useState("");

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    const withName = users.map((u) => ({
      user: u,
      name: (u.displayName ?? u.email ?? u.uid).toLowerCase(),
    }));
    const filtered = term
      ? withName.filter((x) => x.name.includes(term))
      : withName;
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered.map((x) => x.user);
  }, [users, search]);

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
                background: "var(--color-accent-soft)",
                color: "var(--color-accent)",
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
        {selected.length}/{max} assigned
      </span>
    </div>
  );
}
