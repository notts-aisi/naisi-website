"use client";

import { useCallback, useEffect, useState } from "react";
import type { RegistrationSummary } from "@/lib/firestore/registrations";

/** Module-level fetch (carries no React state) so the effect below never setStates synchronously. */
async function fetchSummary(): Promise<RegistrationSummary> {
  const res = await fetch("/api/admin/registrations/summary");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Couldn't load the summary.");
  }
  return (await res.json()) as RegistrationSummary;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Couldn't load the summary.";
}

/**
 * One-shot reader for the registrations flagger summary
 * (`GET /api/admin/registrations/summary`). Not real-time — the signals are a
 * health snapshot, and a manual Refresh re-pulls them, so a per-session fetch is
 * the right cost (no live listener on an aggregation). State updates happen only
 * in the fetch callbacks, mirroring the other admin fetch hooks.
 */
export function useRegistrationSummary() {
  const [summary, setSummary] = useState<RegistrationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSummary()
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
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

  const reload = useCallback(() => {
    setLoading(true);
    fetchSummary()
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  return { summary, loading, error, reload };
}
