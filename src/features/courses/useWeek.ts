"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeCourseWeek, type CourseWeekDoc } from "@/lib/firestore/courses";

/**
 * One week's authored content, resolved GROUP-FIRST: a one-shot client-SDK get
 * of the reader's group's forked copy when there is one
 * (`courseGroups/{groupId}/weeks/{weekId}`), and of the run canonical
 * (`courseRuns/{runId}/weeks/{weekId}`) otherwise.
 *
 * The rules allow any signed-in read on BOTH week subcollections (`published`
 * is a render gate, not a confidentiality boundary — see the overview route),
 * so no route is needed; and curriculum doesn't move under the reader
 * mid-session, so no listener either. The one live thing on the week page is
 * the member's own progress, which is `useRunProgress`'s job.
 *
 * ── WHY `source` IS A PARAMETER AND NOT A PROBE ─────────────────────────────
 * "Does my group have its own copy of this week?" is not a question the client
 * can ask cheaply or safely. Probing the fork first would cost a failed read
 * on every week of every group that has never forked anything (the common
 * case), and racing the two reads would make the ANSWER depend on which
 * returned first. So the overview route — which has already listed the group's
 * fork subcollection — sends `forkedWeekIds`, and this hook resolves against
 * that list. One list, one decision, no probing.
 *
 * `source: null` means the caller does not know yet (the overview is still
 * loading). The hook reports `loading` rather than guessing at the canonical,
 * because a guess that turns out wrong shows a member somebody else's version
 * of their week and then swaps it under them.
 *
 * `canSeeUnpublished` is the caller's role verdict (facilitator/admin). A
 * learner asking for an unpublished week gets `"unpublished"` with `week` kept
 * null — withheld at the data layer so a rendering slip can't leak
 * half-authored content — while facilitators get the doc plus a header chip.
 * That gate applies to a FORKED week exactly as it does to a canonical one: a
 * facilitator who has forked week 6 and not finished it has an unpublished
 * week, and their own members must not see it.
 */

export type WeekStatus = "loading" | "ready" | "unpublished" | "missing" | "error";

/**
 * Where this reader's copy of a week lives. Both fields come from the overview
 * payload; neither is guessable client-side.
 */
export type WeekSource = {
  /** The reader's own group, or null when they have none (run canonical). */
  groupId: string | null;
  /** Week doc ids that exist under that group — `OverviewPayload.forkedWeekIds`. */
  forkedWeekIds: readonly string[];
};

export type WeekResult = {
  status: WeekStatus;
  /** Non-null only when `status === "ready"`. */
  week: CourseWeekDoc | null;
  /**
   * True when the document came from the reader's group's forked copy rather
   * than the run canonical — i.e. their facilitator has personalised it. Set
   * even while `status` is `"unpublished"`, since a facilitator's own draft
   * fork is still a fork.
   */
  forked: boolean;
  error: Error | null;
};

/** Group fork if this week has one, else the run canonical. THE resolution. */
function isForked(weekId: string, source: WeekSource | null): boolean {
  return Boolean(source?.groupId) && (source?.forkedWeekIds.includes(weekId) ?? false);
}

export function useWeek(
  runId: string,
  weekId: string,
  canSeeUnpublished: boolean,
  source: WeekSource | null,
): WeekResult {
  const forked = isForked(weekId, source);
  // Key-tagged snapshot (the `useRunProgress` idiom): a run/week/source switch
  // reads as loading by derivation, with no setState in the effect body. The
  // source is part of the key so a member moved between groups mid-session
  // re-reads rather than keeping the previous group's copy on screen.
  const groupId = source?.groupId ?? "";
  const key =
    runId && weekId && source ? `${runId}/${weekId}/${forked ? groupId : ""}` : "";

  const [state, setState] = useState<{
    key: string;
    week: CourseWeekDoc | null;
    missing: boolean;
    error: Error | null;
  }>({ key: "", week: null, missing: false, error: null });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const ref = forked
      ? doc(getClientDb(), "courseGroups", groupId, "weeks", weekId)
      : doc(getClientDb(), "courseRuns", runId, "weeks", weekId);
    getDoc(ref)
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
  }, [key, runId, weekId, groupId, forked]);

  if (!key || state.key !== key) {
    return { status: "loading", week: null, forked, error: null };
  }
  if (state.error) return { status: "error", week: null, forked, error: state.error };
  if (state.missing) return { status: "missing", week: null, forked, error: null };
  const week = state.week;
  if (!week) return { status: "missing", week: null, forked, error: null };
  if (!week.published && !canSeeUnpublished) {
    // Same face as a missing week on purpose: "exists but you can't see it
    // yet" and "doesn't exist" must be indistinguishable to a learner.
    return { status: "unpublished", week: null, forked, error: null };
  }
  return { status: "ready", week, forked, error: null };
}

export default useWeek;
