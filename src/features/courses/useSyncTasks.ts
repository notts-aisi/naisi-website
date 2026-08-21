"use client";

import { useEffect } from "react";
import type { SyncTasksResult } from "@/app/api/courses/runs/[runId]/sync-tasks/route";

/**
 * The mount trigger for the My Work task mirror.
 *
 * There is no scheduler on App Hosting (Cloud Run, 60s request cap), so
 * nothing on this platform can wake up on Monday morning and materialise a
 * week's task. Mirroring is therefore LAZY and PAGE-DRIVEN: the surfaces a
 * member already opens — the run home, a week page, the dashboard — each fire
 * one POST at `/api/courses/runs/[runId]/sync-tasks`, and the route decides
 * whether there is anything to create. Whichever of them the member happens to
 * open first is the one that pays: the route short-circuits on the enrolment's
 * `lastTaskSyncedWeek` high-water mark, and the session-scoped claim below
 * means the other two trigger points make no request at all.
 *
 * ── WHAT A POST ACTUALLY COSTS (and why the dedupe below exists) ────────────
 * The short-circuit costs no WRITE, but it is not free and it is not "one doc
 * read". Before the route reaches its own logic it calls `getCurrentUser()`,
 * which is `verifySessionCookie(cookie, true)` — the `true` is `checkRevoked`,
 * an Admin Auth `getUser` RPC — followed by a `users/{uid}` doc read. Only then
 * come the enrolment and run reads. So the steady-state cost of one POST is
 * roughly THREE Firestore document reads plus one Auth RPC and one Cloud Run
 * request, and the write is what is saved, not the round trip.
 *
 * That is affordable once. It was not affordable the way it was being spent:
 * `MyCoursesSummary` mounts one INDEPENDENT trigger per live run (up to four),
 * on the most-opened authed page in the app, and every soft navigation between
 * the dashboard and a week page remounts the lot. `syncedKeys` below is the
 * fix — a MODULE-scoped claim, so it outlives every component in the browsing
 * session. The first mount that needs a given (run, anchor week) pays; every
 * later mount of every trigger point is free, whatever unmounted it.
 *
 * Keyed on (runId, anchorWeek), not on runId alone, so a tab left open across
 * a week rollover still mirrors the new week — the cohort advancing is exactly
 * the event this hook exists to notice. A full page load clears the map, and
 * the claim is RELEASED on failure so the "next mount retries" guarantee below
 * survives. (The map is not keyed on uid: signing in as somebody else is a full
 * reload in this app, and an impersonation hand-off is rare enough to leave to
 * the next load.)
 *
 * ── THIS IS BACKGROUND WORK AND IT LOOKS LIKE IT ────────────────────────────
 * The hook holds no state, so it cannot re-render its caller, cannot gate a
 * paint, and cannot put an error on screen. That is the whole contract: a
 * member came here to read week 4, not to watch their task board reconcile. A
 * failed mirror is INVISIBLE and self-healing — the next mount of any of the
 * three trigger points tries again, and the deterministic task id means a
 * retry can never produce a duplicate (see `courseTaskId` in
 * `lib/firestore/courseTasks.ts`).
 *
 * The only report is a console line: a warning on failure (so a real outage is
 * findable in a devtools session) and, outside production, a one-line summary
 * of what the route did.
 *
 * ── WHY NO ABORT ON UNMOUNT ─────────────────────────────────────────────────
 * Every other fetch in `features/courses` cancels on unmount, because every
 * other fetch resolves into state that a departed component must not receive.
 * This one resolves into nothing, and the case worth protecting is the
 * opposite: someone lands on the run home and clicks straight through to a
 * week. Aborting there would cancel the very write the visit existed to
 * trigger. `keepalive` extends that to a real page unload — the request
 * survives the navigation rather than dying in the browser's teardown.
 */

/** Same `[tag]` console convention the rest of the authed app uses. */
const LOG_TAG = "[sync-tasks]";

/**
 * Every (run, anchor week) this browsing session has already POSTed for.
 *
 * MODULE scope on purpose — a per-instance ref would be re-created by every
 * mount, which is precisely the multiplication being removed. Cleared only by a
 * full page load, which is also the only thing that can change who is signed
 * in. Entries are added BEFORE the request and removed again on failure.
 */
const syncedKeys = new Set<string>();

/** `null` anchor = "the caller could not say"; it still gets its own slot. */
function syncKey(runId: string, anchorWeek: number | null): string {
  return `${runId}::${anchorWeek ?? "none"}`;
}

/**
 * Fire the mirror at most once per (runId, anchorWeek) per browsing session.
 *
 * `enabled` is the CALLER's gate, and every callsite spells the same thing
 * with it: an ACTIVE enrolment on this run, LEARNER OR FACILITATOR. Both roles
 * come from a `courseEnrolments` row and both are served by the route — a
 * facilitator works the same week their group does and gets the same weekly
 * card. Who is excluded: an admissions reviewer, a track lead, an admin
 * reading over a cohort's shoulder, and anyone whose enrolment is `withdrawn`,
 * `removed` or `completed`. The route would refuse all of them with a 403, so
 * passing `false` means never asking. Callers that are still loading pass
 * `false` too and the effect re-runs when it flips.
 *
 * `anchorWeek` is the cohort's anchor week as the caller's own payload reports
 * it — dedupe key material ONLY. It is never sent to the route, which always
 * recomputes the week server-side from (run, now); a caller reading a stale
 * anchor can therefore cost an extra POST or defer one to the next load, and
 * can never cause the wrong week to materialise. Pass `null` when it isn't
 * known.
 *
 * The claim is taken BEFORE the request, so StrictMode's double effect pass and
 * two triggers mounting in the same tick both find the slot taken and only one
 * POST goes out. It is released again if the request fails, which keeps the
 * self-healing property above: a failed mirror is retried by the next mount.
 */
export function useSyncTasks(
  runId: string,
  enabled: boolean,
  anchorWeek: number | null,
): void {
  useEffect(() => {
    if (!enabled || !runId) return;
    const key = syncKey(runId, anchorWeek);
    if (syncedKeys.has(key)) return;
    // Claim BEFORE the request, not in its `.then` — two effect passes in the
    // same tick would both see an unclaimed slot otherwise.
    syncedKeys.add(key);

    // Same-origin default carries the session cookie; no `credentials` needed.
    // The route takes no body — the run is in the path and the week is
    // recomputed server-side, never sent by the client.
    fetch(`/api/courses/runs/${encodeURIComponent(runId)}/sync-tasks`, {
      method: "POST",
      keepalive: true,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (Partial<SyncTasksResult> & { error?: string })
          | null;
        if (!res.ok || body?.ok !== true) {
          throw new Error(body?.error ?? `sync-tasks responded ${res.status}`);
        }
        return body as SyncTasksResult;
      })
      .then((result) => {
        // A conflict answers `ok: true` but mirrors nothing: another document
        // occupies the deterministic id, so the route deliberately leaves the
        // high-water mark unstamped for the next mount to retry. Holding the
        // session claim would defeat exactly that, making one conflict skip
        // every later mount until a full page load.
        if (result.conflicted > 0) syncedKeys.delete(key);
        if (process.env.NODE_ENV === "production") return;
        // `weekNumber: null` is a legitimate answer, not a failure: the run
        // hasn't started, is on a break, or has finished.
        console.debug(
          `${LOG_TAG} ${runId} week=${result.weekNumber ?? "none"} created=${result.created} present=${result.alreadyPresent}`,
        );
      })
      .catch((err: unknown) => {
        // Deliberately terminal for THIS attempt: nothing re-throws, nothing
        // sets state, nothing renders. Releasing the claim is what keeps the
        // next mount of any trigger point free to retry — without it the
        // session-scoped dedupe would turn one failed request into a mirror
        // that never appears until the member reloads the page.
        syncedKeys.delete(key);
        console.warn(`${LOG_TAG} mirror skipped for ${runId}`, err);
      });
  }, [runId, enabled, anchorWeek]);
}

/**
 * The same trigger as a render-nothing component, for callers holding a
 * VARIABLE-LENGTH list of runs.
 *
 * The dashboard summary renders up to four runs and cannot call a hook per
 * row — the count changes between loads, and the Rules of Hooks forbid it. One
 * component instance per row is the idiomatic escape hatch: each gets its own
 * hook and its own lifecycle, and none of them put a node in the DOM. The
 * once-per-(run, week) claim they share is module-scoped, so four rows on the
 * dashboard cost four POSTs only on the first dashboard visit of a cohort
 * week, and nothing on any visit after it.
 */
export function SyncTasksTrigger({
  runId,
  anchorWeek,
  enabled = true,
}: {
  runId: string;
  anchorWeek: number | null;
  enabled?: boolean;
}): null {
  useSyncTasks(runId, enabled, anchorWeek);
  return null;
}

export default useSyncTasks;
