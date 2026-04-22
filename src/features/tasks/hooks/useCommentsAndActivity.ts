"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeComment, type CommentDoc } from "@/lib/firestore/comments";
import {
  normalizeActivity,
  type ActivityDoc,
} from "@/lib/firestore/taskActivity";

export type CommentEntry = { kind: "comment"; at: Date | null; comment: CommentDoc };
export type ActivityEntry = { kind: "activity"; at: Date | null; activity: ActivityDoc };
export type FeedEntry = CommentEntry | ActivityEntry;

/**
 * Subscribes to both the comments and activity subcollections for a task and
 * merges them into a single chronologically-sorted feed. `comment_added`
 * activity entries are dropped — the comment itself already carries that
 * information and would otherwise render as a duplicate row.
 */
export function useCommentsAndActivity(taskId: string | null) {
  const [comments, setComments] = useState<CommentDoc[]>([]);
  const [activity, setActivity] = useState<ActivityDoc[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!taskId) return;
    const db = getClientDb();
    const qComments = query(
      collection(db, "tasks", taskId, "comments"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      qComments,
      (snap) => {
        setComments(snap.docs.map((d) => normalizeComment(d.id, d.data())));
        setCommentsLoading(false);
      },
      (err) => {
        console.error("useCommentsAndActivity/comments:", err);
        setError(err);
        setCommentsLoading(false);
      },
    );
    return unsub;
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    const db = getClientDb();
    const qActivity = query(
      collection(db, "tasks", taskId, "activity"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(
      qActivity,
      (snap) => {
        setActivity(snap.docs.map((d) => normalizeActivity(d.id, d.data())));
        setActivityLoading(false);
      },
      (err) => {
        console.error("useCommentsAndActivity/activity:", err);
        setError(err);
        setActivityLoading(false);
      },
    );
    return unsub;
  }, [taskId]);

  const feed = useMemo<FeedEntry[]>(() => {
    const rows: FeedEntry[] = [];
    for (const c of comments) {
      rows.push({ kind: "comment", at: c.createdAt, comment: c });
    }
    for (const a of activity) {
      // Skip comment_added — the comment itself is already in the feed.
      if (a.kind === "comment_added") continue;
      rows.push({ kind: "activity", at: a.createdAt, activity: a });
    }
    rows.sort((a, b) => {
      const at = a.at?.getTime() ?? 0;
      const bt = b.at?.getTime() ?? 0;
      return at - bt;
    });
    return rows;
  }, [comments, activity]);

  return {
    feed,
    comments,
    activity,
    loading: commentsLoading || activityLoading,
    error,
  };
}
