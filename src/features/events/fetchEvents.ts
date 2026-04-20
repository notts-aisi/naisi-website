import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeEvent, type EventDoc } from "@/lib/firestore/events";

/**
 * Server-only fetchers for the public events pages. Runs with the admin SDK
 * so Firestore rules don't gate visibility — we filter by status ourselves.
 */

export async function listPublishedEvents(): Promise<EventDoc[]> {
  const db = getAdminDb();
  if (!db) return [];
  const snap = await db
    .collection("events")
    .where("status", "==", "published")
    .limit(100)
    .get();
  const rows = snap.docs.map((d) => normalizeEvent(d.id, d.data()));
  // Sort upcoming first (by startAt), then undated fall through by updatedAt desc.
  const now = Date.now();
  rows.sort((a, b) => {
    const av = a.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bv = b.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (av !== bv) return (av < now ? 1 : 0) - (bv < now ? 1 : 0) || av - bv;
    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
  });
  return rows;
}

export async function getPublishedEvent(id: string): Promise<EventDoc | null> {
  const db = getAdminDb();
  if (!db) return null;
  const doc = await db.collection("events").doc(id).get();
  if (!doc.exists) return null;
  const event = normalizeEvent(doc.id, doc.data() ?? {});
  if (event.status !== "published" && event.status !== "cancelled") return null;
  return event;
}

/**
 * Like getPublishedEvent but without the status filter. Callers are
 * responsible for gating access (drafters/approvers/admins only).
 */
export async function getEventForPreview(id: string): Promise<EventDoc | null> {
  const db = getAdminDb();
  if (!db) return null;
  const doc = await db.collection("events").doc(id).get();
  if (!doc.exists) return null;
  return normalizeEvent(doc.id, doc.data() ?? {});
}
