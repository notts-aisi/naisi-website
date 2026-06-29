"use client";

import { collection, getDocs } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeCollaborator,
  type CollaboratorDoc,
} from "@/lib/firestore/collaborators";
import { useOneShotList } from "./adminList";

/**
 * One-shot list of all collaborator applications, with manual refresh. Admin-only
 * reads (the Firestore rule allows `isAdmin()` for the whole collection). No
 * `orderBy` (sparse fields drop docs); sorted client-side by createdAt desc.
 */
export function useCollaborators() {
  const { items, loading, refreshing, error, reload } =
    useOneShotList<CollaboratorDoc>(async () => {
      const db = getClientDb();
      const snap = await getDocs(collection(db, "collaborators"));
      const rows = snap.docs.map((d) => normalizeCollaborator(d.id, d.data()));
      rows.sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      );
      return rows;
    }, "collaborators");

  return { collaborators: items, loading, refreshing, error, reload };
}
