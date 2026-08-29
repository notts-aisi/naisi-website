"use client";

import { useSyncExternalStore } from "react";
import { isStandaloneNow, subscribeDisplayMode } from "@/lib/pwa/displayMode";

/**
 * True when the page is running as an installed app rather than a browser tab.
 *
 * Returns false during SSR and on the first client render, then settles to the
 * real value. That ordering is deliberate: standalone-only UI must never be in
 * the server HTML, or it flashes for browser visitors before hydration
 * corrects it.
 */
export function useIsStandalone(): boolean {
  return useSyncExternalStore(subscribeDisplayMode, isStandaloneNow, () => false);
}
