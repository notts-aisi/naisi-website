"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeTask, type TaskDoc } from "@/lib/firestore/tasks";

/**
 * Live task subscription.
 *
 * `initialTask` lets callers seed the hook with a cached doc from their
 * `useTasks` list so the modal can render instantly on click instead of
 * flashing a loading state while the first snapshot arrives (200ms–2s on
 * cold connections). The onSnapshot stream still runs and replaces the
 * seed with live data on the first server push.
 */
export function useTask(
  taskId: string | null | undefined,
  initialTask?: TaskDoc | null,
) {
  const [task, setTask] = useState<TaskDoc | null>(initialTask ?? null);
  const [loading, setLoading] = useState(initialTask ? false : true);
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
