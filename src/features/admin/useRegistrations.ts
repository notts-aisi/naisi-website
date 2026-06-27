"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RegistrationStatus, RegistrationView } from "@/lib/firestore/registrations";

export type RegistrationFilter = "all" | "orphans" | RegistrationStatus;

type ListResponse = { rows: RegistrationView[]; nextCursor: string | null };

/** Module-level fetch (carries no React state) so the effect below never setStates synchronously. */
async function fetchRegistrations(
  filter: RegistrationFilter,
  cursor: string | null,
): Promise<ListResponse> {
  const params = new URLSearchParams({ filter });
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
 * Paginated reader for the admin registrations list. Backed by the server route
 * (`GET /api/admin/registrations`) — not a client onSnapshot — because the
 * collection holds email PII and accumulates orphans without bound. Re-fetches
 * from the top whenever `filter` changes; `loadMore` appends the next page.
 * State updates live in the fetch callbacks, mirroring the other admin hooks.
 */
export function useRegistrations(filter: RegistrationFilter) {
  const [rows, setRows] = useState<RegistrationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);

  // Initial load + reload-on-filter-change. Ref mutation (not setState) resets
  // the cursor; all setState happens in the fetch callbacks.
  useEffect(() => {
    let cancelled = false;
    cursorRef.current = null;
    fetchRegistrations(filter, null)
      .then((data) => {
        if (cancelled) return;
        cursorRef.current = data.nextCursor;
        setHasMore(Boolean(data.nextCursor));
        setRows(data.rows);
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
  }, [filter]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetchRegistrations(filter, cursorRef.current)
      .then((data) => {
        cursorRef.current = data.nextCursor;
        setHasMore(Boolean(data.nextCursor));
        setRows((prev) => [...prev, ...data.rows]);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoadingMore(false));
  }, [filter, loadingMore, hasMore]);

  const reload = useCallback(() => {
    setLoading(true);
    cursorRef.current = null;
    fetchRegistrations(filter, null)
      .then((data) => {
        cursorRef.current = data.nextCursor;
        setHasMore(Boolean(data.nextCursor));
        setRows(data.rows);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [filter]);

  return { rows, loading, loadingMore, error, hasMore, loadMore, reload };
}
