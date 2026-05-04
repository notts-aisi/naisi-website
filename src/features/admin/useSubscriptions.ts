"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";

export type SubscriptionRow = {
  id: string;
  email: string;
  channel: string;
  audience: "user" | "guest";
  audienceId: string;
  status: "pending" | "confirmed" | "unsubscribed";
  source: string;
  createdAt: Date | null;
  confirmedAt: Date | null;
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

function normaliseRow(id: string, data: Record<string, unknown>): SubscriptionRow {
  return {
    id,
    email: String(data.email ?? ""),
    channel: String(data.channel ?? ""),
    audience: data.audience === "user" ? "user" : "guest",
    audienceId: String(data.audienceId ?? ""),
    status:
      data.status === "confirmed"
        ? "confirmed"
        : data.status === "unsubscribed"
          ? "unsubscribed"
          : "pending",
    source: String(data.source ?? ""),
    createdAt: toDate(data.createdAt),
    confirmedAt: toDate(data.confirmedAt),
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
