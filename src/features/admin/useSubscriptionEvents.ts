"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";

export type SubscriptionEventType =
  | "created"
  | "confirmed"
  | "subscribed"
  | "unsubscribed";

export type SubscriptionEventActorKind =
  | "member"
  | "guest"
  | "admin"
  | "system";

export type SubscriptionEventEntry = {
  id: string;
  subscriptionId: string;
  type: SubscriptionEventType;
  actorKind: SubscriptionEventActorKind;
  actorLabel: string;
  at: Date | null;
};

const KNOWN_TYPES: readonly string[] = [
  "created",
  "confirmed",
  "subscribed",
  "unsubscribed",
];
const KNOWN_ACTOR_KINDS: readonly string[] = [
  "member",
  "guest",
  "admin",
  "system",
];

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

function parseEvent(
  id: string,
  data: Record<string, unknown>,
): SubscriptionEventEntry | null {
  const subscriptionId =
    typeof data.subscriptionId === "string" ? data.subscriptionId : "";
  if (!subscriptionId) return null;

  const rawType = data.type;
  const type = (
    KNOWN_TYPES.includes(rawType as string) ? rawType : "created"
  ) as SubscriptionEventType;

  const actor = (data.actor ?? {}) as Record<string, unknown>;
  const rawKind = actor.kind;
  const actorKind = (
    KNOWN_ACTOR_KINDS.includes(rawKind as string) ? rawKind : "system"
  ) as SubscriptionEventActorKind;
  const actorLabel =
    typeof actor.label === "string" && actor.label.trim()
      ? actor.label.trim()
      : "unknown";

  return { id, subscriptionId, type, actorKind, actorLabel, at: toDate(data.at) };
}

/**
 * Live map of `subscriptionId -> chronological event history`, oldest
 * first. The admin Subscriptions tab streams the whole `subscriptionEvents`
 * collection and groups client-side, the same way it does for the
 * subscriptions themselves. Society scale keeps that collection small
 * enough; if it ever grows large, switch to indexed per-row queries.
 *
 * Admin-only; Firestore rules enforce read access.
 */
export function useSubscriptionEvents() {
  const [eventsBySubId, setEventsBySubId] = useState<
    Map<string, SubscriptionEventEntry[]>
  >(new Map());
  const [eventsLoaded, setEventsLoaded] = useState(false);

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      collection(db, "subscriptionEvents"),
      (snap) => {
        const map = new Map<string, SubscriptionEventEntry[]>();
        for (const d of snap.docs) {
          const entry = parseEvent(d.id, d.data());
          if (!entry) continue;
          const list = map.get(entry.subscriptionId);
          if (list) list.push(entry);
          else map.set(entry.subscriptionId, [entry]);
        }
        for (const list of map.values()) {
          list.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
        }
        setEventsBySubId(map);
        setEventsLoaded(true);
      },
      (err) => {
        // Degrade quietly: the table still renders, the history just
        // stays empty. Commonly means the Firestore rule for
        // subscriptionEvents has not been deployed yet.
        console.error("[useSubscriptionEvents] snapshot failed", err);
        setEventsLoaded(true);
      },
    );
    return unsub;
  }, []);

  return { eventsBySubId, eventsLoaded };
}
