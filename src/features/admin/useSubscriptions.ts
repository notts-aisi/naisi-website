"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";

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

/**
 * Backwards-compat: old rows wrote `status: "pending" | "confirmed" |
 * "unsubscribed"` and didn't have the boolean fields. Detect those and
 * derive both booleans inline so the UI doesn't break before the backfill
 * has migrated everything. Once migration is verified, this branch can
 * go away (callers can rely on the booleans existing on every row).
 */
function readBooleanState(data: Record<string, unknown>): {
  confirmed: boolean;
  subscribed: boolean;
} {
  const hasNew =
    typeof data.confirmed === "boolean" && typeof data.subscribed === "boolean";
  if (hasNew) {
    return {
      confirmed: data.confirmed as boolean,
      subscribed: data.subscribed as boolean,
    };
  }
  // Legacy fall-through.
  const status = data.status;
  if (status === "confirmed") return { confirmed: true, subscribed: true };
  if (status === "pending") return { confirmed: false, subscribed: true };
  if (status === "unsubscribed") {
    // We don't know if they were ever confirmed without confirmedAt.
    return { confirmed: Boolean(data.confirmedAt), subscribed: false };
  }
  // Unknown state: treat as lapsed so the row at least renders.
  return { confirmed: false, subscribed: false };
}

function normaliseRow(id: string, data: Record<string, unknown>): SubscriptionRow {
  const { confirmed, subscribed } = readBooleanState(data);
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
 * Live-streamed subscriptions list. Admin-only — Firestore rules enforce
 * read access. Sorts by createdAt descending (newest first), with rows
 * missing createdAt at the bottom so they don't disappear.
 */
export function useSubscriptions() {
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      collection(db, "subscriptions"),
      (snap) => {
        const out = snap.docs
          .map((d) => normaliseRow(d.id, d.data()))
          .sort((a, b) => {
            const at = a.createdAt?.getTime() ?? 0;
            const bt = b.createdAt?.getTime() ?? 0;
            return bt - at;
          });
        setRows(out);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { rows, loading, error };
}
