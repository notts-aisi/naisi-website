"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import styles from "./adminList.module.css";

/**
 * One-shot collection fetch with manual refresh, the replacement for the admin
 * lists' always-open onSnapshot. `load` runs once on mount and again whenever
 * `queryKey` changes (a filter that alters the underlying query); `reload()`
 * re-runs it on demand (the Refresh button). `loading` is the first-load state;
 * `refreshing` is a manual refresh in flight. State only updates from the async
 * callbacks, never synchronously in the effect, matching the existing hooks.
 */
export function useOneShotList<T>(load: () => Promise<T[]>, queryKey: string) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((rows) => {
        if (!cancelled) {
          setItems(rows);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `load` is rebuilt each render; gate on the stable queryKey instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const reload = useCallback(() => {
    setRefreshing(true);
    load()
      .then((rows) => {
        setItems(rows);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setRefreshing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  return { items, loading, refreshing, error, reload };
}

/** Content-width wrapper so admin pages scope their content instead of sprawling. */
export function AdminPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

/** Indeterminate loading bar, shared with the registrations tab. */
export function AdminLoadingBar({ label = "Loading…" }: { label?: string }) {
  return (
    <div className={styles.loadingRow}>
      <span className={styles.loadingBar} aria-hidden="true" />
      <span className={styles.loadingText}>{label}</span>
    </div>
  );
}

/**
 * Client-side display pagination over an already-fetched array. The admin list
 * hooks fetch once (one-shot, not a live listener) and this bounds how many rows
 * render at a time so a long list doesn't dump hundreds of nodes on open.
 */
export function useClientPagination<T>(items: T[], pageSize = 20) {
  const [visible, setVisible] = useState(pageSize);
  const shown = useMemo(() => items.slice(0, visible), [items, visible]);
  const hasMore = items.length > shown.length;
  const loadMore = useCallback(() => setVisible((v) => v + pageSize), [pageSize]);
  const showAll = useCallback(() => setVisible(Number.MAX_SAFE_INTEGER), []);
  return {
    shown,
    hasMore,
    loadMore,
    showAll,
    total: items.length,
    shownCount: shown.length,
  };
}

/**
 * Footer for an admin list: "Showing X of Y", a Load more button when there are
 * more rows, and a Refresh button (the lists are one-shot, not realtime, so this
 * is how an admin pulls the latest).
 */
export function AdminListFooter({
  shownCount,
  total,
  hasMore,
  onLoadMore,
  onRefresh,
  refreshing = false,
  noun = "items",
}: {
  shownCount: number;
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  noun?: string;
}) {
  return (
    <div className={styles.footer}>
      <span className={styles.summary}>
        Showing {shownCount} of {total} {noun}
      </span>
      {hasMore && (
        <button type="button" className={styles.button} onClick={onLoadMore}>
          Load more
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={onRefresh}
        disabled={refreshing}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
