"use client";

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { UserDoc } from "@/lib/firestore/users";

/**
 * Mention autocomplete dropdown — rendered by the TipTap mention suggestion
 * plugin (see mentionSuggestion.ts). Exposes an imperative `onKeyDown`
 * handler so the plugin can forward arrow / enter / escape key events into
 * the dropdown without stealing focus from the editor.
 */
export type MentionDropdownItem = {
  uid: string;
  displayName: string;
  email?: string | null;
  role?: string;
};

export type MentionDropdownHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type Props = {
  items: MentionDropdownItem[];
  command: (item: MentionDropdownItem) => void;
};

const MentionDropdown = forwardRef<MentionDropdownHandle, Props>(function MentionDropdown(
  { items, command },
  ref,
) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") {
        setIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const chosen = items[index];
        if (chosen) command(chosen);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div style={dropdownStyle}>
        <p style={emptyStyle}>No people match.</p>
      </div>
    );
  }

  return (
    <div style={dropdownStyle} role="listbox">
      {items.map((item, i) => (
        <button
          key={item.uid}
          type="button"
          role="option"
          aria-selected={i === index}
          onMouseEnter={() => setIndex(i)}
          onClick={() => command(item)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            width: "100%",
            padding: "0.4rem 0.65rem",
            border: "none",
            background: i === index ? "var(--color-accent-soft)" : "transparent",
            color: i === index ? "var(--color-accent)" : "var(--color-text)",
            fontSize: "var(--text-sm)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span>{item.displayName}</span>
          {item.role && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: "var(--text-xs)",
                color: "var(--color-text-subtle)",
                textTransform: "capitalize",
              }}
            >
              {item.role}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});

const dropdownStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: "14rem",
  maxHeight: "16rem",
  overflowY: "auto",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg)",
  padding: "0.25rem",
};

const emptyStyle: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  color: "var(--color-text-muted)",
  fontSize: "var(--text-sm)",
  margin: 0,
};

export function mentionItemsFromUsers(
  users: UserDoc[],
  query: string,
  limit = 8,
  opts: { includeAll?: boolean } = {},
): MentionDropdownItem[] {
  const term = query.trim().toLowerCase();
  const items: MentionDropdownItem[] = [];
  // Stage 6 (2026-04-26): @all sits at the top of the dropdown when
  // enabled by the caller. Match it on either an empty query or any
  // prefix of "all" so the affordance surfaces during natural typing
  // without dominating unrelated searches.
  if (opts.includeAll && (!term || "all".startsWith(term) || term.startsWith("all"))) {
    items.push({
      uid: "__all__",
      displayName: "all",
      email: null,
      role: "everyone on this task",
    });
  }
  const matches = users.filter((u) => {
    if (!term) return true;
    const hay = (u.displayName ?? u.email ?? u.uid).toLowerCase();
    return hay.includes(term);
  });
  for (const u of matches) {
    if (items.length >= limit) break;
    items.push({
      uid: u.uid,
      displayName: u.displayName ?? u.email ?? u.uid,
      email: u.email,
      role: u.role,
    });
  }
  return items.slice(0, limit);
}

export default MentionDropdown;
