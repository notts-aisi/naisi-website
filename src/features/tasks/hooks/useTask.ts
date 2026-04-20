"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeTask, type TaskDoc } from "@/lib/firestore/tasks";

export function useTask(taskId: string | null | undefined) {
  const [task, setTask] = useState<TaskDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!taskId) return;
    const db = getClientDb();
    const ref = doc(db, "tasks", taskId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setTask(snap.exists() ? normalizeTask(snap.id, snap.data()) : null);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [taskId]);

  // Derive outputs so the null-taskId case doesn't need in-effect state resets.
  return {
    task: taskId ? task : null,
    loading: taskId ? loading : false,
    error,
  };
}
