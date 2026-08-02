"use client";

import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeProject, type ProjectDoc } from "@/lib/firestore/projects";
import { useOneShotList } from "./adminList";

export function useProjects() {
  const { items, loading, refreshing, error, reload } = useOneShotList<ProjectDoc>(
    async () => {
      const fixture = bypass.getProjects();
      if (fixture !== null) return fixture;
      const db = getClientDb();
      const q = query(collection(db, "projects"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      return snap.docs.map((d) => normalizeProject(d.id, d.data()));
    },
    "projects",
  );

  return { projects: items, loading, refreshing, error, reload };
}
