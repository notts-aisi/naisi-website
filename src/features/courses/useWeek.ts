"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeCourseWeek, type CourseWeekDoc } from "@/lib/firestore/courses";

/**
 * One week's authored content: a one-shot client-SDK get of
 * `courseRuns/{runId}/weeks/{weekId}`. The rules allow any signed-in read on
 * the weeks subcollection (`published` is a render gate, not a
 * confidentiality boundary — see the overview route), so no route is needed;
 * and curriculum doesn't move under the reader mid-session, so no listener
 * either. The one live thing on the week page is the member's own progress,
 * which is `useRunProgress`'s job.
 *
 * `canSeeUnpublished` is the caller's role verdict (facilitator/admin). A
 * learner asking for an unpublished week gets `"unpublished"` with `week`
 * kept null — withheld at the data layer so a rendering slip can't leak
 * half-authored content — while facilitators get the doc plus a header chip.
 */

export type WeekStatus = "loading" | "ready" | "unpublished" | "missing" | "error";

export type WeekResult = {
  status: WeekStatus;
  /** Non-null only when `status === "ready"`. */
  week: CourseWeekDoc | null;
  error: Error | null;
};

export function useWeek(
  runId: string,
  weekId: string,
  canSeeUnpublished: boolean,
): WeekResult {
  // Key-tagged snapshot (the `useRunProgress` idiom): a run/week switch reads
  // as loading by derivation, with no setState in the effect body.
  const key = runId && weekId ? `${runId}/${weekId}` : "";

  const [state, setState] = useState<{
    key: string;
    week: CourseWeekDoc | null;
    missing: boolean;
    error: Error | null;
  }>({ key: "", week: null, missing: false, error: null });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    getDoc(doc(getClientDb(), "courseRuns", runId, "weeks", weekId))
      .then((snap) => {
        if (cancelled) return;
        setState({
          key,
          week: snap.exists() ? normalizeCourseWeek(snap.id, snap.data() ?? {}) : null,
          missing: !snap.exists(),
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("useWeek:", err);
        setState({
          key,
          week: null,
          missing: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, runId, weekId]);

  if (!key || state.key !== key) return { status: "loading", week: null, error: null };
  if (state.error) return { status: "error", week: null, error: state.error };
  if (state.missing) return { status: "missing", week: null, error: null };
  const week = state.week;
  if (!week) return { status: "missing", week: null, error: null };
  if (!week.published && !canSeeUnpublished) {
    // Same face as a missing week on purpose: "exists but you can't see it
    // yet" and "doesn't exist" must be indistinguishable to a learner.
    return { status: "unpublished", week: null, error: null };
  }
  return { status: "ready", week, error: null };
}

export default useWeek;
