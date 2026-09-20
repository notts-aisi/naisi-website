"use client";

import { collection, getDocs } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeTrackedLink, type TrackedLinkDoc } from "@/lib/firestore/trackedLinks";

/**
 * The admin console's read of `trackedLinks`. Client-direct, under an
 * admin-only rule, the way the Sources and Projects tabs read theirs.
 *
 * The whole collection, with no `orderBy`. It holds one document per link the
 * society has ever made, which is tens, and the page groups and sorts them
 * itself. An `orderBy("campaign")` would also drop every link whose campaign
 * was never set, because Firestore leaves out documents missing the ordered
 * field.
 *
 * This is the only client-SDK read of the collection, and it owes its entry in
 * `scripts/rules-tests/tests/client-queries.registry.mjs`.
 */
export async function listTrackedLinks(): Promise<TrackedLinkDoc[]> {
  const db = getClientDb();
  const snap = await getDocs(collection(db, "trackedLinks"));
  return snap.docs.map((d) => normalizeTrackedLink(d.id, d.data()));
}
