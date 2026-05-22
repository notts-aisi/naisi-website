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

// TEMP rt-debug: per-listener instance counter. Makes Strict Mode double
// mounts and unexpected re-subscribes visible in the console. Remove with
// the rest of the [rt-debug] instrumentation once the realtime-staleness
// root cause is found.
let rtDebugSeq = 0;

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

    // TEMP rt-debug instrumentation -------------------------------------
    const instId = ++rtDebugSeq;
    const attachedAt = Date.now();
    let firstSnapAt = 0;
    let snapCount = 0;
    console.info(`[rt-debug] rsvps#${instId} attach eventId=${eventId}`);
    const watchdog = window.setTimeout(() => {
      if (firstSnapAt === 0) {
        console.warn(
          `[rt-debug] rsvps#${instId} NO FIRST SNAPSHOT after 10s -` +
            ` listener appears stuck (page will hold the loading screen)`,
        );
      }
    }, 10000);
    // -------------------------------------------------------------------

    const unsub = onSnapshot(
      q,
      (snap) => {
        // TEMP rt-debug
        snapCount += 1;
        if (firstSnapAt === 0) firstSnapAt = Date.now();
        console.info(
          `[rt-debug] rsvps#${instId} snapshot #${snapCount}` +
            ` docs=${snap.docs.length} fromCache=${snap.metadata.fromCache}` +
            ` pendingWrites=${snap.metadata.hasPendingWrites}` +
            ` +${Date.now() - attachedAt}ms`,
        );
        // ---
        setRsvps(toRows(snap.docs));
        setLoading(false);
      },
      (err) => {
        // TEMP rt-debug
        console.error(`[rt-debug] rsvps#${instId} error`, err);
        // ---
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      // TEMP rt-debug
      window.clearTimeout(watchdog);
      console.info(
        `[rt-debug] rsvps#${instId} detach after ${Date.now() - attachedAt}ms,` +
          ` ${snapCount} snapshot(s) received`,
      );
      // ---
      unsub();
    };
  }, [eventId]);

  const refresh = useCallback(async () => {
    if (!eventId) return;
    const db = getClientDb();
    const q = query(collection(db, "eventRsvps"), where("eventId", "==", eventId));
    // TEMP rt-debug
    console.info(`[rt-debug] rsvps refresh() getDocsFromServer eventId=${eventId}`);
    const startedAt = Date.now();
    // ---
    const snap = await getDocsFromServer(q);
    // TEMP rt-debug
    console.info(
      `[rt-debug] rsvps refresh() done docs=${snap.docs.length}` +
        ` +${Date.now() - startedAt}ms`,
    );
    // ---
    setRsvps(toRows(snap.docs));
  }, [eventId]);

  return { rsvps, loading, error, refresh };
}
