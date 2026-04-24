"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeActivity,
  type ActivityDoc,
} from "@/lib/firestore/taskActivity";

/**
 * Subscribes to the task's activity stream and returns only the entries
 * whose `payload.subtaskId` matches the given subtask. Drives the events
 * timeline inside the subtask detail modal ("Alice added herself as
 * assignee", "Bob rejected this subtask", etc.).
 *
 * Client-side filter because `subtaskId` lives on the nested `payload`
 * object — Firestore can't index it without a dedicated top-level mirror,
 * and activity volumes per task are small enough that the filter is cheap.
 */
export function useSubtaskActivity(
  taskId: string | null,
  subtaskId: string | null,
) {
  const [entries, setEntries] = useState<ActivityDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!taskId || !subtaskId) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const db = getClientDb();
    const q = query(
      collection(db, "tasks", taskId, "activity"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const all = snap.docs.map((d) => normalizeActivity(d.id, d.data()));
        setEntries(
          all.filter((a) => {
            const id = a.payload?.subtaskId;
            return typeof id === "string" && id === subtaskId;
          }),
        );
        setLoading(false);
      },
      (err) => {
        console.error("useSubtaskActivity:", err);
        setLoading(false);
      },
    );
    return unsub;
  }, [taskId, subtaskId]);

  return { entries, loading };
}
