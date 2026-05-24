"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeTaskTemplate, type TaskTemplate } from "@/lib/firestore/taskTemplates";

export function useTaskTemplates() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (bypass.isActive) {
      // No template fixtures: show empty list and stop loading.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    const db = getClientDb();
    // `name` is required on every template, so orderBy here is safe.
    const q = query(collection(db, "taskTemplates"), orderBy("name"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setTemplates(snap.docs.map((d) => normalizeTaskTemplate(d.id, d.data())));
        setLoading(false);
      },
      (err) => {
        console.error("useTaskTemplates:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { templates, loading, error };
}
