"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeCollaborator,
  type CollaboratorDoc,
} from "@/lib/firestore/collaborators";

/**
 * Real-time list of all collaborator applications. Admin-only reads (the
 * Firestore rule allows `isAdmin()` for the whole collection). No `orderBy`
 * (sparse fields drop docs); sorted client-side by createdAt desc.
 */
export function useCollaborators() {
  const [collaborators, setCollaborators] = useState<CollaboratorDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      collection(db, "collaborators"),
      (snap) => {
        const rows = snap.docs.map((d) => normalizeCollaborator(d.id, d.data()));
        rows.sort(
          (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
        );
        setCollaborators(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { collaborators, loading, error };
}
