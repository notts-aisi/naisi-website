"use client";

import { useCallback, useEffect, useState } from "react";
import {
  collection,
  getDocsFromServer,
  onSnapshot,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeRsvp, type RsvpDoc } from "@/lib/firestore/events";

/** Map raw RSVP docs and sort by createdAt (oldest first). */
function toRows(docs: QueryDocumentSnapshot[]): RsvpDoc[] {
  const rows = docs.map((d) => normalizeRsvp(d.id, d.data()));
  rows.sort((a, b) => {
    const av = a.createdAt?.getTime() ?? 0;
    const bv = b.createdAt?.getTime() ?? 0;
    return av - bv;
  });
  return rows;
}

/**
 * Live listener for all RSVPs on one event. Sorted client-side by createdAt
 * (oldest first, so the pending queue reads chronologically).
 *
 * `refresh()` does a one-shot server read of the same query. Approving or
 * denying an RSVP runs through an Admin SDK route, not a client write, so the
 * onSnapshot listener carries no local echo for it: the organiser depends
 * entirely on the realtime channel to see their own action land. When that
 * channel lags, the queue looks stale until a full reload. Re-pulling from the
 * server right after the action removes that dependency.
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
        setRsvps(toRows(snap.docs));
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [eventId]);

  const refresh = useCallback(async () => {
    if (!eventId) return;
    const db = getClientDb();
    const q = query(collection(db, "eventRsvps"), where("eventId", "==", eventId));
    const snap = await getDocsFromServer(q);
    setRsvps(toRows(snap.docs));
  }, [eventId]);

  return { rsvps, loading, error, refresh };
}
