"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { recordLastRoute } from "./lastRoute";

/**
 * Records the current authed-area route for RelaunchRestore. Mounted from
 * (app)/layout.tsx, so only paths a signed-in member can reach are ever
 * written; see lastRoute.ts for why that placement is load-bearing.
 *
 * Writes on every route change AND on visibilitychange to hidden, which is
 * the last reliable moment before iOS kills a backgrounded app (pagehide
 * and unload do not fire on an app-switcher kill). The extra write is
 * redundant when nothing changed, and localStorage writes are cheap.
 *
 * Renders nothing.
 */
export function LastRouteTracker() {
  const pathname = usePathname();

  useEffect(() => {
    recordLastRoute(pathname);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") recordLastRoute(pathname);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [pathname]);

  return null;
}
