"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildLinkStats,
  shiftDateKey,
  type AttributedSignup,
  type LinkStats,
  type ScanDay,
} from "@/lib/campaign/linkStats";
import { scanBucket } from "@/lib/campaign/scanBuckets";
import { ALL_TIME, listAttributedSignups, listScanDays } from "./linkStatsData";

export type StatsRange = "7" | "30" | "all";

export const STATS_RANGES: readonly { value: StatsRange; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "all", label: "All time" },
];

/** The first London day a range covers, today included. Null for all time. */
function fromDateFor(range: StatsRange): string | null {
  if (range === "all") return null;
  return shiftDateKey(scanBucket(new Date()).date, -(Number(range) - 1));
}

/**
 * Scan and sign-up numbers for /admin/links.
 *
 * One-shot with a reload, like the list it sits beside. Both reads are fetched
 * ONCE, for all time, and the range is applied in the browser: switching
 * between 7 days and 30 then costs no read at all, and the collections are
 * small (one scan document per link per day).
 */
export function useLinkStats() {
  const [range, setRange] = useState<StatsRange>("7");
  const [days, setDays] = useState<ScanDay[]>([]);
  const [signups, setSignups] = useState<AttributedSignup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listScanDays(ALL_TIME), listAttributedSignups()])
      .then(([nextDays, nextSignups]) => {
        if (cancelled) return;
        setDays(nextDays);
        setSignups(nextSignups);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const fromDate = fromDateFor(range);
  const stats: Map<string, LinkStats> = useMemo(
    () => buildLinkStats({ days, signups, fromDate }),
    [days, signups, fromDate],
  );

  /** Day by day for every slug, for the daily export. Oldest first. */
  const dailyRows = useMemo(
    () =>
      days
        .filter((day) => day.count > 0 && (!fromDate || day.date >= fromDate))
        .sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug)),
    [days, fromDate],
  );

  return { range, setRange, stats, dailyRows, fromDate, loading, error, reload };
}
