"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
  type Query,
  type QueryConstraint,
} from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeTask, type TaskDoc, type TaskSource } from "@/lib/firestore/tasks";

type UseTasksArgs = {
  projectId?: string;
  /** Tasks where this uid is in `completerUids`. Reviewer-only membership is
   * not yet surfaced via this hook; the My Work page will gain a reviewer
   * merge in a follow-up. */
  completerUid?: string;
  source?: TaskSource;
  includeArchived?: boolean;
  /**
   * When set, the query adds `visibility == 'committee'` so we only fetch
   * committee-visible tasks. Used for the committee board view.
   */
  visibility?: "committee" | "assignees-only";
};

export function useTasks(args: UseTasksArgs = {}) {
  // Memoize args so callers passing object literals don't restart the
  // subscription on every render.
  const key = JSON.stringify(args);
  const stable = useMemo(() => args, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tasks, setTasks] = useState<TaskDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fixture = bypass.getTasks(stable);
    if (fixture !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTasks(fixture);
      setLoading(false);
      return;
    }
    const db = getClientDb();
    const constraints: QueryConstraint[] = [];
    if (stable.projectId) constraints.push(where("projectId", "==", stable.projectId));
    if (stable.completerUid) {
      constraints.push(where("completerUids", "array-contains", stable.completerUid));
    }
    if (stable.source) constraints.push(where("source", "==", stable.source));
    if (stable.visibility) constraints.push(where("visibility", "==", stable.visibility));

    // Intentionally NOT ordering server-side — dueDate is sparse and updatedAt
    // ordering conflicts with the visibility filter. We sort client-side below.
    const q: Query = query(collection(db, "tasks"), ...constraints);

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeTask(d.id, d.data()));
        const filtered = stable.includeArchived ? rows : rows.filter((t) => !t.archived);
        // Sort: not-done first by dueDate asc (nulls last), then by updatedAt desc.
        filtered.sort((a, b) => {
          if ((a.status === "done") !== (b.status === "done")) {
            return a.status === "done" ? 1 : -1;
          }
          if (a.dueDate && b.dueDate) return a.dueDate.getTime() - b.dueDate.getTime();
          if (a.dueDate) return -1;
          if (b.dueDate) return 1;
          const au = a.updatedAt?.getTime() ?? 0;
          const bu = b.updatedAt?.getTime() ?? 0;
          return bu - au;
        });
        setTasks(filtered);
        setLoading(false);
      },
      (err) => {
        console.error("useTasks:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [stable]);

  return { tasks, loading, error };
}
