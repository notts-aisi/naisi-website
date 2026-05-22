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
  const key = taskId && subtaskId ? `${taskId}/${subtaskId}` : "";
  // The latest delivered snapshot, tagged with the (taskId, subtaskId) it
  // belongs to. `loading` is derived from whether that tag is current, so the
  // effect never has to setState synchronously to reset on an id change.
  const [state, setState] = useState<{ key: string; entries: ActivityDoc[] }>({
    key: "",
    entries: [],
  });

  useEffect(() => {
    if (!taskId || !subtaskId) return;
    const subKey = `${taskId}/${subtaskId}`;
    const db = getClientDb();
    const q = query(
      collection(db, "tasks", taskId, "activity"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const all = snap.docs.map((d) => normalizeActivity(d.id, d.data()));
        setState({
          key: subKey,
          entries: all.filter((a) => {
            const id = a.payload?.subtaskId;
            return typeof id === "string" && id === subtaskId;
          }),
        });
      },
      (err) => {
        console.error("useSubtaskActivity:", err);
        setState({ key: subKey, entries: [] });
      },
    );
    return unsub;
  }, [taskId, subtaskId]);

  if (!key) return { entries: [], loading: false };
  if (state.key !== key) return { entries: [], loading: true };
  return { entries: state.entries, loading: false };
}
