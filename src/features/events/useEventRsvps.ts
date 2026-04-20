"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeRsvp, type RsvpDoc } from "@/lib/firestore/events";

/**
 * Live listener for all RSVPs on one event. Sorted client-side by createdAt
 * (oldest first, so the pending queue reads chronologically).
 */
export function useEventRsvps(eventId: string) {
  const [rsvps, setRsvps] = useState<RsvpDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!eventId) {
      setLoading(false);
      return;
    }
    const db = getClientDb();
    const q = query(collection(db, "eventRsvps"), where("eventId", "==", eventId));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeRsvp(d.id, d.data()));
        rows.sort((a, b) => {
          const av = a.createdAt?.getTime() ?? 0;
          const bv = b.createdAt?.getTime() ?? 0;
          return av - bv;
        });
        setRsvps(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [eventId]);

  return { rsvps, loading, error };
}
