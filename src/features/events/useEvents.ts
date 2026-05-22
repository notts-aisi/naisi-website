"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeEvent, type EventDoc } from "@/lib/firestore/events";

// TEMP rt-debug: per-listener instance counter for the events-list listener.
// Remove with the rest of the [rt-debug] instrumentation once the realtime
// root cause is found.
let rtDebugSeq = 0;

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

    // TEMP rt-debug instrumentation -------------------------------------
    const instId = ++rtDebugSeq;
    const attachedAt = Date.now();
    let firstSnapAt = 0;
    let snapCount = 0;
    console.info(`[rt-debug] events#${instId} attach`);
    const watchdog = window.setTimeout(() => {
      if (firstSnapAt === 0) {
        console.warn(
          `[rt-debug] events#${instId} NO FIRST SNAPSHOT after 10s -` +
            ` listener appears stuck (events tab holds the loading screen)`,
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
          `[rt-debug] events#${instId} snapshot #${snapCount}` +
            ` docs=${snap.docs.length} fromCache=${snap.metadata.fromCache}` +
            ` pendingWrites=${snap.metadata.hasPendingWrites}` +
            ` +${Date.now() - attachedAt}ms`,
        );
        // ---
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
        // TEMP rt-debug
        console.error(`[rt-debug] events#${instId} error`, err);
        // ---
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      // TEMP rt-debug
      window.clearTimeout(watchdog);
      console.info(
        `[rt-debug] events#${instId} detach after ${Date.now() - attachedAt}ms,` +
          ` ${snapCount} snapshot(s) received`,
      );
      // ---
      unsub();
    };
  }, []);

  return { events, loading, error };
}
