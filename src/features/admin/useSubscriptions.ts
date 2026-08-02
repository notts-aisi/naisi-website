"use client";

import { collection, getDocs } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useOneShotList } from "./adminList";

/**
 * Display state derived from (confirmed, subscribed) for the admin UI:
 *  - "subscribed":   confirmed && subscribed   (delivers)
 *  - "unsubscribed": confirmed && !subscribed  (was confirmed, opted out)
 *  - "pending":      !confirmed && subscribed  (waiting on inbox-confirm click)
 *  - "lapsed":       !confirmed && !subscribed (signed up, never confirmed, dropped)
 */
export type SubscriptionDisplayStatus =
  | "subscribed"
  | "unsubscribed"
  | "pending"
  | "lapsed";

export type SubscriptionRow = {
  id: string;
  email: string;
  channel: string;
  audience: "user" | "guest";
  audienceId: string;
  /** Optional first / preferred name. */
  name: string;

  /** Sticky once true. Set on first confirmation, never reset. */
  confirmed: boolean;
  /** Current subscription state. Toggleable. */
  subscribed: boolean;

  /** Derived display label, computed once at parse time. */
  displayStatus: SubscriptionDisplayStatus;

  source: string;
  createdAt: Date | null;
  confirmedAt: Date | null;
  subscribedAt: Date | null;
  unsubscribedAt: Date | null;
  lastSentAt: Date | null;
};

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate: () => Date }).toDate();
    } catch {
      return null;
    }
  }
  return null;
}

function deriveDisplayStatus(
  confirmed: boolean,
  subscribed: boolean,
): SubscriptionDisplayStatus {
  if (confirmed && subscribed) return "subscribed";
  if (confirmed && !subscribed) return "unsubscribed";
  if (!confirmed && subscribed) return "pending";
  return "lapsed";
}

function normaliseRow(id: string, data: Record<string, unknown>): SubscriptionRow {
  // After the schema split + cleanup migration, every row has the new
  // booleans. If a row somehow doesn't (a write path we missed, a
  // hand-edit in the Firestore console), default to a benign "lapsed"
  // state so the row still renders rather than crashing the table.
  const confirmed = typeof data.confirmed === "boolean" ? data.confirmed : false;
  const subscribed = typeof data.subscribed === "boolean" ? data.subscribed : false;
  return {
    id,
    email: String(data.email ?? ""),
    channel: String(data.channel ?? ""),
    audience: data.audience === "user" ? "user" : "guest",
    audienceId: String(data.audienceId ?? ""),
    name: typeof data.name === "string" ? data.name : "",
    confirmed,
    subscribed,
    displayStatus: deriveDisplayStatus(confirmed, subscribed),
    source: String(data.source ?? ""),
    createdAt: toDate(data.createdAt),
    confirmedAt: toDate(data.confirmedAt),
    subscribedAt: toDate(data.subscribedAt),
    unsubscribedAt: toDate(data.unsubscribedAt),
    lastSentAt: toDate(data.lastSentAt),
  };
}

/**
 * One-shot subscriptions list with manual refresh. Admin-only — Firestore
 * rules enforce read access. Sorts by createdAt descending (newest first),
 * with rows missing createdAt at the bottom so they don't disappear.
 */
export function useSubscriptions() {
  const { items, loading, refreshing, error, reload } = useOneShotList<SubscriptionRow>(
    async () => {
      const db = getClientDb();
      const snap = await getDocs(collection(db, "subscriptions"));
      return snap.docs
        .map((d) => normaliseRow(d.id, d.data()))
        .sort((a, b) => {
          const at = a.createdAt?.getTime() ?? 0;
          const bt = b.createdAt?.getTime() ?? 0;
          return bt - at;
        });
    },
    "subscriptions",
  );

  return { rows: items, loading, refreshing, error, reload };
}
