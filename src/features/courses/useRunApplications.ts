"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApplicationCounts } from "@/lib/firestore/courses";
import type { CourseApplicationStatus } from "@/lib/firestore/courseApplications";

/**
 * The admissions review payload for one run: `GET /api/courses/runs/[runId]/
 * applications`.
 *
 * One-shot with a manual refresh — the `useOneShotList` idiom the admin lists
 * use, not `onSnapshot`. Two reasons it must stay a fetch:
 *
 *  1. `courseApplications` is own-row-read + admin in rules, so a NON-ADMIN
 *     reviewer cannot read the collection from the client at all. The route is
 *     the only way they see anything, and it is also what strips applicant
 *     email addresses out of their copy of the data (locked decision: reviewers
 *     get names, never addresses).
 *  2. Nothing here changes behind the reviewer's back. Applications arrive over
 *     days; decisions are made by the person looking at the screen. A standing
 *     listener would buy a live flip nobody is waiting for.
 *
 * Every field below is exactly what the route returns — no client-side
 * derivation of anything security-relevant, and in particular no attempt to
 * recover an email that the server chose not to send.
 */

/** One applicant row as the reviewer sees it. */
export type AdmissionsRow = {
  uid: string;
  displayName: string;
  /**
   * ADMINS ONLY. The route sends `null` to non-admin reviewers, and this is
   * the single source of truth for whether an address is shown — the UI must
   * never reconstruct one from anywhere else.
   */
  email: string | null;
  /** Paid-membership snapshot at apply time. A BADGE for reviewers, never a gate. */
  paidMembership: boolean;
  status: CourseApplicationStatus;
  /** Keyed by the run's form-question ids. Member-authored — render as text. */
  answers: Record<string, unknown>;
  availability: string[];
  reviewerNotes: string | null;
  reviewerPreferredGroupId: string | null;
  reviewerPreferredFacilitatorUid: string | null;
  decidedByName: string | null;
  /** ISO instant, or null while undecided. */
  decidedAt: string | null;
  decisionReason: string | null;
  /** ISO instant. */
  createdAt: string;
};

/** A group the reviewer may record as a preferred placement. */
export type AdmissionsGroup = {
  id: string;
  name: string;
  /** e.g. "Tuesdays 18:00–19:30". */
  sessionLabel: string;
  /** Names come from here — the queue never reads the users collection. */
  facilitators: { uid: string; displayName: string }[];
};

/** Just enough of the run to head the queue. */
export type AdmissionsRun = {
  id: string;
  label: string;
  courseId: string;
  courseTitle: string;
  academicYear: string;
  applicationCounts: ApplicationCounts;
  /**
   * OPTIONAL, additive: the run's application-form question labels. Answers
   * are keyed by opaque question ids (`q_<base36>_<rand>`), so without this the
   * queue can only head each answer "Question 2". Nothing breaks when the route
   * omits it — the queue falls back — but sending it is what makes the
   * applications readable, so it is worth adding to the payload.
   */
  questions?: { id: string; label: string }[];
};

export type AdmissionsPayload = {
  run: AdmissionsRun;
  groups: AdmissionsGroup[];
  applications: AdmissionsRow[];
};

export type RunApplications = {
  data: AdmissionsPayload | null;
  /** True on the first load AND on a manual refresh (`data` stays put). */
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

export function useRunApplications(runId: string): RunApplications {
  const [data, setData] = useState<AdmissionsPayload | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  // The nonce whose fetch has landed. Deriving `loading` from the pair (rather
  // than flipping a boolean inside the effect body, which is a cascading
  // render) means a post-decision `reload()` reads as "refreshing" straight
  // away — `useMyApplication`'s idiom.
  const [settledNonce, setSettledNonce] = useState(-1);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetch(`/api/courses/runs/${encodeURIComponent(runId)}/applications`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (AdmissionsPayload & { error?: string })
          | null;
        if (!res.ok || !body || !body.run) {
          // The route's own sentence where it gave one: a reviewer who has been
          // removed from the run needs to read "Forbidden", not "failed".
          throw new Error(body?.error ?? `Couldn't load applications (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
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

export default useRunApplications;
