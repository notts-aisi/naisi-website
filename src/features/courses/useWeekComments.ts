"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WeekCommentsPayload } from "@/app/api/courses/runs/[runId]/comments/route";

/**
 * The cohort comment lane for one week: `GET /api/courses/runs/[runId]/
 * comments?week=N`, grouped client-side by `itemId` for the per-material
 * disclosures.
 *
 * LAZY, and fetched at most once per page for the whole week: the hook stays
 * idle until the first disclosure calls `load()`, then every other material's
 * disclosure reads from the same payload. One member opening three
 * disclosures is one request, not three — the route returns the full week
 * regardless, so per-item fetches would just re-download the same rows.
 *
 * `reload()` refreshes only if a load has already been requested (used after
 * the member saves their own reflection, and after an admin hides or unhides
 * one, so the lane reflects the write). Before that there is nothing on screen
 * to refresh, and the eventual first `load()` fetches fresh anyway.
 *
 * The row type comes from the route module (`import type`, erased at
 * compile): the payload shape and this hook's contract are the same thing.
 * That includes `row.moderated`, which the route sets ONLY for admin callers —
 * a non-admin's payload has hidden rows removed, so the flag's absence means
 * "not hidden from you", and a UI that reads it must gate on the viewer's role
 * rather than on the flag alone.
 */

export type WeekCommentRow = WeekCommentsPayload["items"][number];

export type WeekComments = {
  /** Rows grouped by the material/checklist item they hang off. */
  byItemId: ReadonlyMap<string, WeekCommentRow[]>;
  /** True once a fetch has succeeded — counts are only honest after this. */
  loaded: boolean;
  loading: boolean;
  error: Error | null;
  /** Request the week's comments; no-op if already requested. */
  load: () => void;
  /** Re-fetch, but only if `load()` has already happened. */
  reload: () => void;
};

export function useWeekComments(runId: string, weekNumber: number): WeekComments {
  const [items, setItems] = useState<WeekCommentRow[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // nonce 0 = never requested; the effect stays idle until load() bumps it.
  const [nonce, setNonce] = useState(0);
  const [settledNonce, setSettledNonce] = useState(0);

  useEffect(() => {
    if (!runId || nonce === 0) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(`/api/courses/runs/${encodeURIComponent(runId)}/comments?week=${weekNumber}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (WeekCommentsPayload & { error?: string })
          | null;
        if (!res.ok || !body || !Array.isArray(body.items)) {
          throw new Error(body?.error ?? `Couldn't load cohort notes (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (cancelled) return;
        setItems(payload.items);
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
  }, [runId, weekNumber, nonce]);

  const load = useCallback(() => setNonce((n) => (n === 0 ? 1 : n)), []);
  const reload = useCallback(() => setNonce((n) => (n === 0 ? 0 : n + 1)), []);

  const byItemId = useMemo(() => {
    const map = new Map<string, WeekCommentRow[]>();
    for (const row of items ?? []) {
      const list = map.get(row.itemId);
      if (list) list.push(row);
      else map.set(row.itemId, [row]);
    }
    return map;
  }, [items]);

  return {
    byItemId,
    loaded: items !== null,
    loading: nonce !== settledNonce,
    error,
    load,
    reload,
  };
}

export default useWeekComments;
