"use client";

import { useCallback, useEffect, useState } from "react";
import type { RegistrationStatus, RegistrationView } from "@/lib/firestore/registrations";

export type RegistrationFilter = "all" | "orphans" | RegistrationStatus;

const PAGE_SIZE = 100;
// Safety cap: load up to MAX_PAGES * PAGE_SIZE rows into the client. The
// collection is small for a society; if it ever exceeds this the page shows a
// "first N" note and we'd switch back to server-side filtering.
const MAX_PAGES = 10;

type ListResponse = { rows: RegistrationView[]; nextCursor: string | null };

async function fetchPage(cursor: string | null): Promise<ListResponse> {
  const params = new URLSearchParams({ filter: "all", limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`/api/admin/registrations?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Couldn't load registrations.");
  }
  return (await res.json()) as ListResponse;
}

/** Page through the whole collection (capped) so filtering can be client-side. */
async function fetchAll(): Promise<{ rows: RegistrationView[]; truncated: boolean }> {
  const rows: RegistrationView[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchPage(cursor);
    rows.push(...data.rows);
    cursor = data.nextCursor;
    if (!cursor) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Couldn't load registrations.";
}

/**
 * Loads ALL registration rows ONCE and caches them, so switching filter pills is
 * instant client-side filtering instead of a fresh server query per click. The
 * cache persists until `reload()` (the Refresh button, or after a delete).
 *
 * Trade-off vs. the previous per-filter server query: this reads the whole
 * collection (≤ MAX_PAGES·PAGE_SIZE rows) on open rather than one bounded page,
 * which is fine at a society's scale and much snappier. If signups ever blow past
 * the cap the page surfaces a "showing first N" note — revisit server-side
 * filtering then. State updates live in the fetch callbacks (no setState in an
 * effect body), matching the other admin hooks.
 */
export function useAllRegistrations() {
  const [rows, setRows] = useState<RegistrationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // Initial load. `loading` starts true (useState), so the effect never setStates
  // synchronously — it only resolves in the async callbacks.
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setTruncated(res.truncated);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Manual refresh (Refresh button / post-delete). Runs from an event handler, so
  // setLoading here is not a setState-in-effect.
  const reload = useCallback(() => {
    setLoading(true);
    fetchAll()
      .then((res) => {
        setRows(res.rows);
        setTruncated(res.truncated);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  return { rows, loading, error, truncated, reload };
}
