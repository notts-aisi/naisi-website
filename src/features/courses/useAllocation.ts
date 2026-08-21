"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The allocation payload for one course run, plus the three mutations the
 * board drives: `GET/POST /api/courses/runs/[runId]/allocation*`.
 *
 * One-shot fetch with a manual refresh — the `useRunApplications` idiom, for
 * the same two reasons and one more:
 *
 *  1. `courseEnrolments` is own-row-read + admin in rules, so a non-admin
 *     TRACK LEAD cannot read the collection from the client at all. The route
 *     is the only way they see the board, and it is also what strips applicant
 *     email addresses out of the payload — allocation is a NAME-ONLY surface
 *     (locked decision: facilitators and track leads never see addresses).
 *  2. Nothing moves behind the allocator's back. A run is placed in one
 *     sitting by the person looking at the screen.
 *  3. Placement is transactional server-side (capacity is checked against the
 *     in-transaction `memberCount`), so the only trustworthy view of "who is
 *     where" is the one the server just committed. Every action below
 *     re-reads rather than patching local state; the board layers a short
 *     optimistic override on top purely so a dropped card doesn't visibly
 *     snap back during the round trip.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * One enrolment per (run, uid) — deterministic doc id `courseEnrolmentId(runId,
 * uid)` — and `groupId` is a single scalar. Double placement is structurally
 * impossible, not merely prevented. Nothing in this file may ever model group
 * membership as an array of uids: a group's members are `people.filter(p =>
 * p.groupId === group.id)`, always a query over the one scalar.
 * ───────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Wire types — exactly what the route returns, no client-side derivation of
// anything security-relevant.
// ---------------------------------------------------------------------------

/** Just enough of the run to head the board. */
export type AllocRun = {
  id: string;
  label: string;
  courseTitle: string;
  academicYear: string;
  /** ISO instant of the last publish, or null while unpublished. */
  allocationPublishedAt: string | null;
};

/** One column of the board. `memberCount` is the server-owned counter. */
export type AllocGroup = {
  id: string;
  name: string;
  /** null = uncapped. The board renders "∞" rather than inventing a number. */
  capacity: number | null;
  /** e.g. "Tuesdays 18:00–19:30"; empty when the slot isn't set up yet. */
  sessionLabel: string;
  /** NAMES ONLY — no uids to resolve, no users read from this surface. */
  facilitatorNames: string[];
  memberCount: number;
};

/**
 * One accepted applicant, joined with their enrolment if they have one.
 * `enrolmentStatus: "none"` means accepted but never enrolled — the normal
 * starting state for everyone on a fresh board.
 */
export type AllocRow = {
  uid: string;
  displayName: string;
  /** Paid-membership badge. Context for the allocator, never a gate. */
  paidMembership: boolean;
  /** The session labels they ticked when applying. May be empty. */
  availability: string[];
  reviewerPreferredGroupId: string | null;
  /** A NAME, not a uid — the reviewer's suggestion, resolved server-side. */
  reviewerPreferredFacilitatorName: string | null;
  reviewerNotes: string | null;
  /** THE placement. A scalar, by design — see the invariant above. */
  groupId: string | null;
  enrolmentStatus: "none" | "active" | "withdrawn" | "removed";
  /** ISO instant of their allocation email, or null if they've had none. */
  allocatedEmailAt: string | null;
};

export type AllocationPayload = {
  run: AllocRun;
  groups: AllocGroup[];
  /** Every ACCEPTED application for the run, placed or not. */
  people: AllocRow[];
};

// ---------------------------------------------------------------------------
// Action results
//
// The actions never throw: an allocation board must be able to say WHICH group
// refused WHICH person, and a rejected promise flattens that into one string.
// Every result is a discriminated union the caller can render precisely.
// ---------------------------------------------------------------------------

export type Placement = { uid: string; groupId: string | null };

export type PlaceResult =
  | {
      ok: true;
      placed: number;
      /** Per-person refusals (group full, no longer accepted, …). */
      rejected: { uid: string; reason: string }[];
    }
  | { ok: false; error: string };

export type PublishResult =
  | { ok: true; emailed: number; skipped: number; unplaced: string[] }
  | {
      ok: false;
      error: string;
      /**
       * NAMES of accepted applicants with no group. Non-empty only on the
       * 409 refusal, where the route did nothing at all — the board renders
       * these in the status rail rather than a toast, because "who is still
       * unplaced" is a work list, not a notification.
       */
      unplaced: string[];
    };

export type RemoveResult = { ok: true } | { ok: false; error: string };

export type UseAllocation = {
  data: AllocationPayload | null;
  /** True on the first load AND on a manual refresh (`data` stays put). */
  loading: boolean;
  error: Error | null;
  reload: () => void;
  /** Move people between groups (`groupId: null` returns them to the pool). */
  place: (placements: Placement[]) => Promise<PlaceResult>;
  /** Enrol everyone placed + email them. Refuses while anyone is unplaced. */
  publishAllocation: () => Promise<PublishResult>;
  /** Take one person off the run entirely (their enrolment, not their application). */
  removeEnrolment: (uid: string) => Promise<RemoveResult>;
};

// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a route response into `{ ok, body }` without ever throwing on a
 * malformed body — a 500 from the platform (HTML error page) must read as a
 * sentence, not a JSON syntax error.
 */
async function readBody<T extends object>(
  res: Response,
): Promise<(T & { ok?: true; error?: string }) | null> {
  return (await res.json().catch(() => null)) as
    | (T & { ok?: true; error?: string })
    | null;
}

export function useAllocation(runId: string): UseAllocation {
  const [data, setData] = useState<AllocationPayload | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  // The nonce whose fetch has landed. Deriving `loading` from the pair (rather
  // than flipping a boolean inside the effect body, which is a cascading
  // render) means a post-placement `reload()` reads as "refreshing" straight
  // away — `useRunApplications`' idiom.
  const [settledNonce, setSettledNonce] = useState(-1);

  const base = useMemo(
    () => `/api/courses/runs/${encodeURIComponent(runId)}`,
    [runId],
  );

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetch(`${base}/allocation`)
      .then(async (res) => {
        const body = await readBody<AllocationPayload>(res);
        if (!res.ok || !body || !body.run) {
          // The route's own sentence where it gave one: a track lead who has
          // been removed from the run needs to read "Forbidden", not "failed".
          throw new Error(
            body?.error ?? `Couldn't load the allocation board (${res.status}).`,
          );
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
  }, [runId, base, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * `{placements: [{uid, groupId}]}` in one call. Batching matters: the route
   * runs the whole batch through one transaction per chunk, so a bulk move of
   * twelve people either lands as twelve consistent counter deltas or refuses
   * per-person with a reason — never a half-applied loop of twelve requests.
   */
  const place = useCallback(
    async (placements: Placement[]): Promise<PlaceResult> => {
      if (placements.length === 0) return { ok: true, placed: 0, rejected: [] };
      try {
        const res = await fetch(`${base}/allocate`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ placements }),
        });
        const body = await readBody<{
          placed: number;
          rejected: { uid: string; reason: string }[];
        }>(res);
        if (!res.ok || !body?.ok) {
          return {
            ok: false,
            error: body?.error ?? `That move didn't go through (${res.status}).`,
          };
        }
        // Even a fully-rejected batch reloads: `memberCount` may have moved
        // under us, and that is exactly why the batch was refused.
        reload();
        return {
          ok: true,
          placed: typeof body.placed === "number" ? body.placed : 0,
          rejected: Array.isArray(body.rejected) ? body.rejected : [],
        };
      } catch (e: unknown) {
        return { ok: false, error: messageFrom(e) };
      }
    },
    [base, reload],
  );

  /**
   * Publish: enrol everyone placed, subscribe them to the cohort channel, and
   * email them their group. The 409 branch is the load-bearing one — the route
   * refuses outright while any accepted applicant has no group and does
   * nothing else, returning their NAMES so the board can point at the work
   * that is left.
   */
  const publishAllocation = useCallback(async (): Promise<PublishResult> => {
    try {
      const res = await fetch(`${base}/allocation/publish`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
      const body = await readBody<{
        emailed: number;
        skipped: number;
        unplaced: string[];
      }>(res);
      const unplaced = Array.isArray(body?.unplaced) ? body.unplaced : [];
      if (res.status === 409) {
        return {
          ok: false,
          error:
            body?.error ??
            "Some accepted applicants still aren't in a group — nothing was sent.",
          unplaced,
        };
      }
      if (!res.ok || !body?.ok) {
        return {
          ok: false,
          error: body?.error ?? `Publishing didn't go through (${res.status}).`,
          unplaced: [],
        };
      }
      reload();
      return {
        ok: true,
        emailed: typeof body.emailed === "number" ? body.emailed : 0,
        skipped: typeof body.skipped === "number" ? body.skipped : 0,
        unplaced,
      };
    } catch (e: unknown) {
      return { ok: false, error: messageFrom(e), unplaced: [] };
    }
  }, [base, reload]);

  /**
   * Removing an enrolment is NOT the same as un-placing someone: `place(uid,
   * null)` returns them to the pool still expecting a place, while this ends
   * their enrolment on the run. Their application and its decision are
   * untouched, which is why they stay on the board afterwards.
   */
  const removeEnrolment = useCallback(
    async (uid: string): Promise<RemoveResult> => {
      try {
        const res = await fetch(
          `${base}/enrolments/${encodeURIComponent(uid)}/remove`,
          { method: "POST", headers: JSON_HEADERS },
        );
        const body = await readBody<Record<string, never>>(res);
        if (!res.ok || !body?.ok) {
          return {
            ok: false,
            error: body?.error ?? `That didn't go through (${res.status}).`,
          };
        }
        reload();
        return { ok: true };
      } catch (e: unknown) {
        return { ok: false, error: messageFrom(e) };
      }
    },
    [base, reload],
  );

  return {
    data,
    loading: settledNonce !== nonce,
    error,
    reload,
    place,
    publishAllocation,
    removeEnrolment,
  };
}

export default useAllocation;
