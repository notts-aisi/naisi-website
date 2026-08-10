"use client";

/**
 * Full document navigation. Use ONLY after the server-side `__session` cookie
 * has been minted, swapped, or cleared — or when recovering from a server
 * redirect this document already observed.
 *
 * WHY THIS EXISTS
 *
 * Next 16's client ROUTE cache records, per requested URL, the URL the server
 * redirected that request to, and a soft `router.push`/`replace` onto a URL
 * with a still-fresh entry replays that recorded redirect with NO network
 * request at all. So a route that 307'd to /login a minute ago keeps landing
 * on /login even once a valid session cookie exists.
 *
 * Concretely, in next@16.2.4:
 *  - segment-cache/navigation.js:73-75 short-circuits when the route entry is
 *    `EntryStatus.Fulfilled`, handing off to navigateUsingPrefetchedRouteTree,
 *    which at :156 takes the destination straight from `route.canonicalUrl`.
 *  - That canonicalUrl is written with the POST-REDIRECT url, by
 *    segment-cache/cache.js:1062 (prefetch) and navigation.js:231 (navigation).
 *  - The entry lives for STATIC_STALETIME_MS — router-reducer/reducers/
 *    navigate-reducer.js:31, defaulted to 5 * 60 seconds in
 *    build/define-env.js:113. Route entries always use the *static* stale time
 *    (cache.js:702), so `experimental.staleTimes.dynamic` cannot shorten it.
 *
 * There is no client-side escape hatch. `invalidateEntirePrefetchCache` is the
 * only function that bumps the route cache version (cache.js:226-231) and it
 * has exactly one caller in the whole of Next 16.2.4: the Server Action
 * reducer (server-action-reducer.js:208). In particular:
 *  - `router.refresh()` does NOT help — refresh-reducer.js:29-32 says in its
 *    own comment that a refresh invalidates the segment cache but not the
 *    route cache.
 *  - `<Link prefetch={false}>` does NOT help — navigation.js:231 writes the
 *    entry on the navigation itself, not only on prefetch.
 *  - A cache-busting query param does NOT help — with optimistic routing off
 *    (the default), cache.js:360-405 copies the poisoned entry's redirect
 *    search onto the optimistic entry.
 *
 * A document load discards the entire JS heap, which takes the route cache,
 * the segment cache and the bfcache with it. That is the mechanism, and it is
 * guaranteed by the browser rather than by framework internals.
 *
 * Prior art in this repo: src/auth/impersonation.ts:16-20 reached the same
 * conclusion for the view-as session swap and already uses window.location.
 */
export function hardNavigate(
  dest: string,
  mode: "assign" | "replace" = "assign",
): void {
  // Same-origin paths only. Mirrors the open-redirect guard on `safeNext` in
  // src/app/(auth)/AuthEntry.tsx so this helper can never widen it: unlike
  // router.push, window.location will happily cross origins.
  const safe = dest.startsWith("/") && !dest.startsWith("//") ? dest : "/";
  if (mode === "replace") window.location.replace(safe);
  else window.location.assign(safe);
}
