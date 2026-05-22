"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeComment, type CommentDoc } from "@/lib/firestore/comments";

/**
 * Subcomments (Phase 3): subscribes to comments on a single subtask. Uses
 * a Firestore `where subtaskId == <id>` filter against the task's comments
 * subcollection. Task-level comments (`subtaskId: null`) are naturally
 * excluded by the equality filter.
 */
export function useSubtaskComments(
  taskId: string | null,
  subtaskId: string | null,
) {
  const key = taskId && subtaskId ? `${taskId}/${subtaskId}` : "";
  // The latest delivered snapshot, tagged with the (taskId, subtaskId) it
  // belongs to. `loading` is derived from whether that tag is current, so the
  // effect never has to setState synchronously to reset on an id change.
  const [state, setState] = useState<{
    key: string;
    comments: CommentDoc[];
    error: Error | null;
  }>({ key: "", comments: [], error: null });

  useEffect(() => {
    if (!taskId || !subtaskId) return;
    const subKey = `${taskId}/${subtaskId}`;
    const db = getClientDb();
    const q = query(
      collection(db, "tasks", taskId, "comments"),
      where("subtaskId", "==", subtaskId),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setState({
          key: subKey,
          comments: snap.docs.map((d) => normalizeComment(d.id, d.data())),
          error: null,
        });
      },
      (err) => {
        console.error("useSubtaskComments:", err);
        setState({ key: subKey, comments: [], error: err });
      },
    );
    return unsub;
  }, [taskId, subtaskId]);

  if (!key) return { comments: [], loading: false, error: null };
  if (state.key !== key) return { comments: [], loading: true, error: null };
  return { comments: state.comments, loading: false, error: state.error };
}
