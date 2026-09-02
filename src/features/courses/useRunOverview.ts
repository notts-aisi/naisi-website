"use client";

import { useCallback, useEffect, useState } from "react";
import type { OverviewPayload } from "@/app/api/courses/runs/[runId]/overview/route";

/**
 * Everything the run home and the week pages need about one run:
 * `GET /api/courses/runs/[runId]/overview` — the run and its week plan, the
 * computed current week, the published week index, the caller's own enrolment,
 * every group they hold (their placement and each group they facilitate),
 * and the `access` flags the `[runId]` layout gates on.
 *
 * One-shot with a manual refresh, same argument as `useMyRuns`: the payload
 * joins `courseRuns` + its `weeks` subcollection + `courseEnrolments` +
 * `courseGroups`, three of which the client cannot read directly, and the
 * current week is recomputed server-side per request rather than stored. The
 * one thing on these pages that DOES move under the reader — the member's own
 * check-offs — is live via `useRunProgress`.
 *
 * `access` is a mirror of the server's decision, never the decision itself:
 * the layout and every route re-derive it. Rendering a facilitator panel off a
 * tampered flag would show an empty panel, not someone else's data.
 */

export type RunOverview = {
  data: OverviewPayload | null;
  /** True on the first load AND on a manual refresh (`data` stays put). */
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

export function useRunOverview(runId: string): RunOverview {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  // The nonce whose fetch has landed — `useRunApplications`' idiom, so a
  // `reload()` after (say) a group change reads as "refreshing" immediately.
  const [settledNonce, setSettledNonce] = useState(-1);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(`/api/courses/runs/${encodeURIComponent(runId)}/overview`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (OverviewPayload & { error?: string })
          | null;
        if (!res.ok || !body || !body.run) {
          // A member who has been removed from the run needs to read
          // "Forbidden", not "failed".
          throw new Error(body?.error ?? `Couldn't load this course (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (cancelled) return;
        // `groups` is newer than `group`. A response served by a container that
        // predates it would leave the field undefined and every caller
        // mapping over it would throw, so it is normalised once here rather
        // than defended against at each render site.
        setData({
          ...payload,
          groups: Array.isArray(payload.groups)
            ? payload.groups
            : payload.group
              ? [payload.group]
              : [],
        });
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setSettledNonce(nonce);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading: settledNonce !== nonce, error, reload };
}

export default useRunOverview;
