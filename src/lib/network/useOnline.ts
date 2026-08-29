"use client";

import { useSyncExternalStore } from "react";

/**
 * Is the browser online, live.
 *
 * navigator.onLine is a conservative signal: false is trustworthy (the
 * device definitely has no network route), while true only means "not
 * definitely offline" — a captive portal or a dead upstream still reads
 * true. That asymmetry is fine for what this powers: surfacing "you are
 * offline, this will not save" the moment it is knowable, without claiming
 * to prove the opposite. Firestore listeners are the deeper truth for data
 * freshness (see useSiteNotice's fromCache handling); this hook is the
 * cheap, instant, page-wide signal.
 *
 * SSR snapshot is `true`: assuming online on the server means a normal
 * visitor never sees an offline banner flash during hydration, and a
 * genuinely offline visitor sees it appear a frame later.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;
