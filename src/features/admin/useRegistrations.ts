"use client";

import { useCallback, useEffect, useState } from "react";
import type { RegistrationStatus, RegistrationView } from "@/lib/firestore/registrations";

export type RegistrationFilter = "all" | "orphans" | RegistrationStatus;

// First-page size on open. Cursor pagination means the tab loads only this many
// rows on mount; the admin pulls more with Load more, one page at a time.
const PAGE_SIZE = 50;

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Couldn't load registrations.";
}

/**
 * Loads the FIRST page of registration rows on open and lets the admin pull more
 * with `loadMore()` (each call fetches the next cursor page and APPENDS), instead
 * of reading the whole collection up front. `hasMore` is true while the server
 * still hands back a `nextCursor`. `reload()` (Refresh button, or after a delete)
 * resets back to the first page.
 *
 * Trade-off vs. the previous load-everything approach: the loaded rows are only
 * the first N (plus any the admin has loaded), so the page's client-side filter
 * pills apply to the LOADED rows, not the whole collection. The flags panel
 * (server summary) carries the full counts. State updates live in the fetch
 * callbacks (no setState in an effect body), matching the other admin hooks.
 */
export function useAllRegistrations() {
  const [rows, setRows] = useState<RegistrationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Initial load (first page only). `loading` starts true (useState), so the
  // effect never setStates synchronously — it only resolves in the async callbacks.
  useEffect(() => {
    let cancelled = false;
    fetchPage(null)
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setCursor(res.nextCursor);
        setHasMore(res.nextCursor !== null);
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

  // Append the next cursor page. Runs from an event handler (the Load more
  // button), so setLoadingMore here is not a setState-in-effect.
  const loadMore = useCallback(() => {
    if (!cursor) return;
    setLoadingMore(true);
    fetchPage(cursor)
      .then((res) => {
        setRows((prev) => [...prev, ...res.rows]);
        setCursor(res.nextCursor);
        setHasMore(res.nextCursor !== null);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoadingMore(false));
  }, [cursor]);

  // Manual refresh (Refresh button / post-delete): reset back to the first page.
  // Runs from an event handler, so setLoading here is not a setState-in-effect.
  const reload = useCallback(() => {
    setLoading(true);
    fetchPage(null)
      .then((res) => {
        setRows(res.rows);
        setCursor(res.nextCursor);
        setHasMore(res.nextCursor !== null);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  return { rows, loading, loadingMore, error, hasMore, loadMore, reload };
}
