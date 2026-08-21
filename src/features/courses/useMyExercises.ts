"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExerciseResponseWire } from "@/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route";
import type { MyExercisesPayload } from "@/app/api/courses/runs/[runId]/my-exercises/route";

/**
 * The caller's OWN exercise answers for one week:
 * `GET /api/courses/runs/[runId]/my-exercises?week=N`, indexed by exercise id
 * for the per-exercise submission forms on the week page.
 *
 * One-shot, then locally maintained. `apply(row)` merges the row a submit or
 * autosave just returned, so a save costs one request rather than a write plus
 * a re-read — and, more importantly, the member's own field is never yanked out
 * from under them by a refetch landing mid-edit.
 *
 * IDLE ON AN EMPTY `runId`, which is the hook's "not for you" switch: a
 * facilitator or admin reading a week has no rows here (the route serves own
 * rows only), and asking would be a request whose answer is always empty. The
 * week page passes `""` for a non-learner viewer rather than calling the hook
 * conditionally.
 *
 * ── `loaded` IS A SAFETY FLAG, NOT A CONVENIENCE ────────────────────────────
 * The response doc id is deterministic per (run, member, week, exercise), so an
 * autosave REPLACES whatever is there. A form seeded from "no row" therefore
 * overwrites a stored answer the moment it is typed into — and "no row" is
 * exactly what a FAILED fetch also looks like. `loaded` is the difference
 * between "you have written nothing here" (a load said so) and "we don't know"
 * (a load failed), and the week page must not render a writable box on the
 * second. `reload()` is the way back from it.
 *
 * ── KEY-TAGGED STORE ────────────────────────────────────────────────────────
 * The `useReviewQueue` idiom, and load-bearing here for the same reason: the
 * week page is ONE component instance across /weeks/3 → /weeks/4, so a save
 * dispatched from week 3 (an unmount flush, say) can resolve after week 4's
 * rows have arrived. Merging that row would put last week's answer under this
 * week's prompt. Every mutation carries the key its data was fetched for, and a
 * merge whose key no longer matches is dropped.
 *
 * The row type comes from the submit route module (`import type`, erased at
 * compile) so the wire shape and this hook's contract stay the same thing.
 */

export type MyExercises = {
  /** One row per exercise the member has drafted or submitted this week. */
  byExerciseId: ReadonlyMap<string, ExerciseResponseWire>;
  loading: boolean;
  /**
   * A fetch for the CURRENT (run, week) has come back successfully, so an
   * absent row genuinely means "nothing written". False while loading, and
   * false after a failure — see the safety note above.
   */
  loaded: boolean;
  error: Error | null;
  /** Retry the fetch for the current (run, week). */
  reload: () => void;
  /** Merge one updated/created row in place — no refetch. */
  apply: (row: ExerciseResponseWire) => void;
};

const EMPTY: ReadonlyArray<ExerciseResponseWire> = [];

/**
 * A separator that cannot occur in a run id or a week number, so the composite
 * key can never be spelled two ways. (`useReviewQueue` uses the same one.)
 */
const SEP = " ";

export function useMyExercises(runId: string, weekNumber: number): MyExercises {
  const idle = !runId;
  const key = idle ? "" : `${runId}${SEP}${weekNumber}`;

  // `rows: null` means "not known" — never "empty". Only a successful fetch
  // (or a merge on top of one) produces an array.
  const [store, setStore] = useState<{
    key: string;
    rows: ExerciseResponseWire[] | null;
    error: Error | null;
  }>({ key: "", rows: null, error: null });
  const [nonce, setNonce] = useState(0);
  // The stamp whose fetch has landed. Comparing stamps — rather than toggling a
  // boolean from inside the effect — keeps `loading` honest across a week change
  // and makes a manual `reload()` read as "loading" straight away.
  const [settled, setSettled] = useState("");

  const stamp = `${key}${SEP}${nonce}`;

  useEffect(() => {
    if (idle) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(
      `/api/courses/runs/${encodeURIComponent(runId)}/my-exercises?week=${weekNumber}`,
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (MyExercisesPayload & { error?: string })
          | null;
        if (!res.ok || !body || !Array.isArray(body.responses)) {
          throw new Error(body?.error ?? `Couldn't load your answers (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (!cancelled) setStore({ key, rows: payload.responses, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A failed RETRY keeps the rows it already had — they were verified by
        // a load that did work, and dropping them would turn a transient blip
        // into "your answers are gone". A failed FIRST load of this key has
        // nothing to keep: rows stay null, which is what stops the week page
        // rendering a writable box over an answer it cannot see.
        setStore((prev) => ({
          key,
          rows: prev.key === key ? prev.rows : null,
          error: e instanceof Error ? e : new Error(String(e)),
        }));
      })
      .finally(() => {
        if (!cancelled) setSettled(stamp);
      });
    return () => {
      cancelled = true;
    };
  }, [idle, runId, weekNumber, key, stamp, nonce]);

  const fresh = store.key === key ? store : null;
  const rows = fresh?.rows ?? null;

  const apply = useCallback(
    (row: ExerciseResponseWire) => {
      setStore((prev) => {
        // KEY GUARD: a row saved for a week the page has since left is not this
        // week's data. Dropping it is right — the write itself still landed,
        // and returning to that week refetches.
        if (prev.key !== key) return prev;
        const list = prev.rows ?? [];
        // The doc id is deterministic per (run, member, week, exercise), so id
        // equality IS row identity — an edit replaces, a first answer appends.
        const i = list.findIndex((r) => r.id === row.id);
        if (i === -1) return { ...prev, rows: [...list, row] };
        const next = list.slice();
        next[i] = row;
        return { ...prev, rows: next };
      });
    },
    [key],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const byExerciseId = useMemo(() => {
    const map = new Map<string, ExerciseResponseWire>();
    for (const row of rows ?? EMPTY) map.set(row.exerciseId, row);
    return map;
  }, [rows]);

  const loading = idle ? false : settled !== stamp;

  return {
    byExerciseId,
    loading,
    loaded: !idle && !loading && rows !== null,
    error: fresh?.error ?? null,
    reload,
    apply,
  };
}

export default useMyExercises;
