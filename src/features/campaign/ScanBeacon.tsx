"use client";

import { useEffect } from "react";
import { scanToCount } from "@/lib/campaign/scanBeacon";

/**
 * Counts a scan of a printed code, from whichever page the scan landed on.
 *
 * Mounted once in the root layout rather than on the pages a code happens to
 * point at today, so a code that is pointed somewhere else tomorrow is still
 * counted without anybody remembering to add this there. It renders nothing
 * and does nothing at all on a page with no `?q=` in its address.
 *
 * It runs after the page is already on screen and everything in it is inside
 * a try/catch: counting a scan is never worth a broken page, least of all the
 * page somebody has just walked up to a stall to open. A failed request is
 * dropped silently for the same reason.
 *
 * Reads `window.location` directly, not `useSearchParams`, which would need a
 * Suspense boundary and would pull every static page under this layout into
 * client-side rendering for the sake of a counter.
 */

// One count per document load. React runs an effect twice in development, and
// this module outlives a client-side navigation.
let fired = false;

export function ScanBeacon() {
  useEffect(() => {
    if (fired) return;
    try {
      const scan = scanToCount(window.location.search);
      if (!scan) return;
      fired = true;

      const url = `/api/q/${encodeURIComponent(scan.slug)}/scan`;
      // sendBeacon is a POST the browser finishes even if the person taps a
      // link straight away. It reports false when it could not queue one.
      const queued = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url);
      if (!queued) void fetch(url, { method: "POST", keepalive: true }).catch(() => {});

      // Next keeps its router in step with a native replaceState, so this
      // changes the address bar and nothing else: no reload, no refetch.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${scan.nextSearch}${window.location.hash}`,
      );
    } catch {
      // Deliberately nothing.
    }
  }, []);

  return null;
}
