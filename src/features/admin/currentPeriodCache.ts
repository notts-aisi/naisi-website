/**
 * Which membership period is CURRENT, fetched once and shared by every row of
 * the admin Members list.
 *
 * ## Why a cache at all
 *
 * The answer is the same for every member on the page, so without this the
 * Members tab would fire one `/api/admin/membership/periods` request per row.
 *
 * ## Why the cache expires, and why "no period" is never kept
 *
 * The first version memoised the promise forever, which made the one state an
 * admin is most likely to be in the middle of changing the stickiest: create a
 * period, make it current, walk back to Members by client navigation, and every
 * row still said "No membership period is current" until a hard reload. So two
 * rules, and they are the whole point of this module:
 *
 *  1. A NULL answer is never kept. "No period is current" and "that request
 *     failed" both arrive here as null (the fetcher swallows the error), and
 *     neither is worth remembering for a second longer than the flight it came
 *     from. The memo is dropped as the answer resolves, so the next mount asks
 *     again.
 *  2. A real answer expires. `CURRENT_PERIOD_TTL_MS` bounds how stale a badge
 *     can be after somebody else moves the pointer, without turning the list
 *     back into a request per row.
 *
 * On top of both, the console calls `resetCurrentPeriodCache()` after any write
 * that could change the answer, so the admin who made the change never waits
 * out the TTL.
 *
 * The factory is exported separately from the singleton so the rules above can
 * be executed in a test with a fake clock and a fake fetcher.
 */

export type CurrentPeriod = { id: string; year: string; label: string } | null;

/**
 * How long a real answer is reused. Half a minute: long enough that opening
 * Members is one request rather than twenty, short enough that a period made
 * current in another tab shows up without anybody being told to reload.
 */
export const CURRENT_PERIOD_TTL_MS = 30_000;

export type CurrentPeriodCache = {
  /** The current period, from the memo when it is still good. */
  load: () => Promise<CurrentPeriod>;
  /** Forget whatever is memoised. Called after a write that could change it. */
  reset: () => void;
};

export function createCurrentPeriodCache(
  fetchPeriod: () => Promise<CurrentPeriod>,
  {
    ttlMs = CURRENT_PERIOD_TTL_MS,
    now = () => Date.now(),
  }: { ttlMs?: number; now?: () => number } = {},
): CurrentPeriodCache {
  let entry: { promise: Promise<CurrentPeriod>; expiresAt: number } | null = null;

  // Only ever drops the entry it was handed. A reset while a request is in
  // flight must not be undone by that request landing afterwards.
  function drop(promise: Promise<CurrentPeriod>) {
    if (entry && entry.promise === promise) entry = null;
  }

  function load(): Promise<CurrentPeriod> {
    const at = now();
    if (entry && entry.expiresAt > at) return entry.promise;
    const promise: Promise<CurrentPeriod> = fetchPeriod().then(
      (period) => {
        if (period === null) drop(promise);
        return period;
      },
      (err: unknown) => {
        drop(promise);
        throw err;
      },
    );
    entry = { promise, expiresAt: at + ttlMs };
    return promise;
  }

  return {
    load,
    reset() {
      entry = null;
    },
  };
}

/** The route call, with every failure flattened to "no period is current". */
async function fetchCurrentPeriod(): Promise<CurrentPeriod> {
  try {
    const res = await fetch("/api/admin/membership/periods");
    if (!res.ok) return null;
    const data = (await res.json()) as {
      periods: { id: string; year: string; label: string }[];
      currentPeriodId: string | null;
    };
    const match = data.periods.find((p) => p.id === data.currentPeriodId);
    return match ? { id: match.id, year: match.year, label: match.label } : null;
  } catch {
    return null;
  }
}

const cache = createCurrentPeriodCache(fetchCurrentPeriod);

/** The current period, shared by every chip on the page. */
export function loadCurrentPeriod(): Promise<CurrentPeriod> {
  return cache.load();
}

/**
 * Forget the memoised answer. The membership console calls this after creating
 * a period and after moving the CURRENT pointer, so the Members list picks the
 * change up on its next render instead of on the next hard reload.
 */
export function resetCurrentPeriodCache(): void {
  cache.reset();
}
