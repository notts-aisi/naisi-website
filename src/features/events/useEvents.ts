"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeEvent, type EventDoc } from "@/lib/firestore/events";

/**
 * All events the current user is allowed to read (gated by Firestore rules:
 * drafters + approvers + admins see everything; members see published;
 * unauthenticated readers only see public + published via a different query).
 *
 * Sorted client-side by updatedAt desc so we don't trip over sparse-field
 * orderBy gotchas (see CLAUDE.md).
 */
export function useEvents() {
  const [events, setEvents] = useState<EventDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const q = query(collection(db, "events"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeEvent(d.id, d.data()));
        rows.sort((a, b) => {
          const av = a.updatedAt?.getTime() ?? 0;
          const bv = b.updatedAt?.getTime() ?? 0;
          return bv - av;
        });
        setEvents(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { events, loading, error };
}
