"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeCourseProgress,
  type CourseProgressDoc,
} from "@/lib/firestore/courseProgress";

/**
 * The signed-in member's own progress rows for one run, live.
 *
 * `onSnapshot` rather than the one-shot fetch the rest of the courses hooks
 * use, because this is the only courses surface where the data changes under
 * the reader: check-off writes straight from the client, and the listener is
 * what makes the optimistic flip settle into the real row (and snap back when
 * the write is refused) without a refetch.
 *
 * ── THE uid CONSTRAINT IS NOT AN OPTIMISATION ──────────────────────────────
 * `allow read` on `courseProgress` covers `list`, and the rule is
 * `resource.data.uid == request.auth.uid`. Firestore refuses a list query it
 * cannot prove satisfies that up front, so a query without the `uid` equality
 * is denied WHOLESALE — not filtered. Never drop it, and never widen this hook
 * to "everyone's rows"; the cohort comments lane is a route for exactly that
 * reason.
 * ───────────────────────────────────────────────────────────────────────────
 */

export type RunProgress = {
  /**
   * Keyed by `itemId` — the address a material / checklist row already has.
   * One row per item by construction (the doc id binds run + uid + item), so
   * the map can never lose a duplicate.
   */
  byItemId: Map<string, CourseProgressDoc>;
  loading: boolean;
  error: Error | null;
};

/** Shared empty result. Read-only by contract — nothing here ever mutates it. */
const EMPTY: Map<string, CourseProgressDoc> = new Map();

export function useRunProgress(runId: string): RunProgress {
  const { user, loading: authLoading } = useAuth();
  const uid = user?.uid ?? null;
  // The (run, member) pair the rows belong to. Tagging the delivered snapshot
  // with it — the `useSubtaskComments` idiom — lets `loading` be derived on a
  // run or account switch instead of reset by a setState in the effect body.
  const key = runId && uid ? `${runId}/${uid}` : "";

  const [state, setState] = useState<{
    key: string;
    rows: CourseProgressDoc[];
    error: Error | null;
  }>({ key: "", rows: [], error: null });

  useEffect(() => {
    // Signed out, or auth hasn't answered yet: an unauthenticated list is a
    // guaranteed denial, and rendering "nothing completed" at someone who has
    // completed things is worse than rendering the loading state a beat longer.
    if (!key || !uid) return;
    const q = query(
      collection(getClientDb(), "courseProgress"),
      where("runId", "==", runId),
      where("uid", "==", uid),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setState({
          key,
          rows: snap.docs.map((d) => normalizeCourseProgress(d.id, d.data())),
          error: null,
        });
      },
      (err) => {
        console.error("useRunProgress:", err);
        setState({ key, rows: [], error: err });
      },
    );
    return unsub;
  }, [key, runId, uid]);

  const fresh = state.key === key;
  const byItemId = useMemo(() => {
    if (!fresh) return EMPTY;
    const map = new Map<string, CourseProgressDoc>();
    for (const row of state.rows) map.set(row.itemId, row);
    return map;
  }, [fresh, state.rows]);

  if (!key) return { byItemId: EMPTY, loading: authLoading, error: null };
  if (!fresh) return { byItemId: EMPTY, loading: true, error: null };
  return { byItemId, loading: false, error: state.error };
}

export default useRunProgress;
