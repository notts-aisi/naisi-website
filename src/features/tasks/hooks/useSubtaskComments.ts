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
  const [comments, setComments] = useState<CommentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!taskId || !subtaskId) {
      setComments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const db = getClientDb();
    const q = query(
      collection(db, "tasks", taskId, "comments"),
      where("subtaskId", "==", subtaskId),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setComments(snap.docs.map((d) => normalizeComment(d.id, d.data())));
        setLoading(false);
      },
      (err) => {
        console.error("useSubtaskComments:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [taskId, subtaskId]);

  return { comments, loading, error };
}
