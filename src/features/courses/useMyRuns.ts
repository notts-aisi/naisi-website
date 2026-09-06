"use client";

import { useCallback, useEffect, useState } from "react";
import type { MePayload, MyRunEntry } from "@/app/api/courses/me/route";

/**
 * Every run the signed-in member touches, in any role: `GET /api/courses/me`.
 * The data behind the `/learn` hub.
 *
 * One-shot with a manual refresh — the `useRunApplications` idiom, not
 * `onSnapshot`. Two reasons it has to be a fetch:
 *
 *  1. It spans collections the client cannot read. `courseEnrolments` is
 *     own-row-read only, `courseGroups` is restricted (it carries the meeting
 *     link), `courseApplications` is own-row-read + admin, and the run's role
 *     arrays live on `courseRuns`. The route is the one place those join, and
 *     it is also what keeps the payload PII-free — names and labels, never
 *     addresses. (The application row is the sharpest case: it carries the
 *     applicant's email and their answers, and the route reads exactly two
 *     fields off it.)
 *  2. Nothing here moves while the hub is open. The two rows that appear —
 *     an OFFER when a reviewer accepts, an enrolment when allocation
 *     publishes — are both minutes-to-days apart from the member opening this
 *     page, and both are followed by an email; the current week is a pure
 *     function of `(run, now)` recomputed server-side on each request. There
 *     is no document worth holding a channel open for.
 *
 * The type comes from the route module (`import type`, so it is erased at
 * compile and no server code reaches the bundle): the payload shape and the
 * hook's contract are the same thing, and stating it twice is how they drift.
 */

export type MyRuns = {
  runs: MyRunEntry[];
  /** True on the first load AND on a manual refresh (`runs` stays put). */
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

export function useMyRuns(): MyRuns {
  const [runs, setRuns] = useState<MyRunEntry[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  // The nonce whose fetch has landed. Deriving `loading` from the pair (rather
  // than flipping a boolean inside the effect body, which is a cascading
  // render) means a `reload()` reads as "refreshing" straight away.
  const [settledNonce, setSettledNonce] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    // No `credentials` option on purpose: the session cookie rides the
    // same-origin default, and this route is same-origin by construction.
    fetch("/api/courses/me")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (MePayload & { error?: string })
          | null;
        if (!res.ok || !body || !Array.isArray(body.runs)) {
          // The route's own sentence where it gave one — a member whose
          // account is still pending needs to read why, not "failed".
          throw new Error(body?.error ?? `Couldn't load your courses (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (cancelled) return;
        setRuns(payload.runs);
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
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { runs, loading: settledNonce !== nonce, error, reload };
}

export default useMyRuns;
