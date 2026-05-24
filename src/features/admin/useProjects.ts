"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeProject, type ProjectDoc } from "@/lib/firestore/projects";

export function useProjects() {
  const [projects, setProjects] = useState<ProjectDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fixture = bypass.getProjects();
    if (fixture !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProjects(fixture);
      setLoading(false);
      return;
    }
    const db = getClientDb();
    const q = query(collection(db, "projects"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setProjects(snap.docs.map((d) => normalizeProject(d.id, d.data())));
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { projects, loading, error };
}
