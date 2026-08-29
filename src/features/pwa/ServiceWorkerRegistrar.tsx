"use client";

import { useEffect } from "react";
import { mark, warn } from "@/lib/devMonitor";
import { SERVICE_WORKER_ENABLED } from "./config";

/**
 * Registers /sw.js for every visitor, or tears it down when the master
 * switch in ./config.ts is off. Renders nothing.
 *
 * Why every visitor and not just installed apps: Chrome's install prompt
 * machinery (beforeinstallprompt) and the offline fallback both want the
 * worker present before the user installs, and the worker's contract (see
 * public/sw.js) makes it a no-op for everything except failed navigations,
 * so there is nothing to scope away from browser visitors.
 *
 * Gating: production always; local dev only behind NEXT_PUBLIC_SW_ENABLE,
 * set in .env.local and nowhere else. next dev serves everything uncached
 * and a worker there mostly interferes with HMR. NOTE the App Hosting
 * caveat from CLAUDE.md: console env vars are always [BUILD, RUNTIME], so a
 * stray NEXT_PUBLIC_SW_ENABLE on a backend would be build-inlined; the
 * production leg of this gate does not read it, so that mistake cannot
 * double-enable anything, but keep the var out of the consoles anyway.
 *
 * updateViaCache: "none" plus the no-cache header in next.config.ts means
 * update checks always hit the network for sw.js itself. reg.update() on
 * visibilitychange covers long-lived installed-app sessions that would
 * otherwise only check on cold launch; iOS in particular is lazy about
 * automatic update checks.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const enabled =
      process.env.NODE_ENV === "production" ||
      process.env.NEXT_PUBLIC_SW_ENABLE === "true";
    if (!enabled) return;

    if (!SERVICE_WORKER_ENABLED) {
      // Kill path. Unregister everything on the origin and drop our caches.
      void (async () => {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
          const keys = await caches.keys();
          await Promise.all(
            keys.filter((k) => k.startsWith("naisi-")).map((k) => caches.delete(k)),
          );
          mark("[sw] disabled: unregistered and purged caches", {
            registrations: regs.length,
          });
        } catch (err) {
          warn("[sw] teardown failed", { err });
        }
      })();
      return;
    }

    let cancelled = false;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void navigator.serviceWorker.getRegistration().then((reg) => reg?.update());
    };

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        if (cancelled) return;
        mark("[sw] registered", { scope: reg.scope });
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch((err) => {
        // Registration failure is not user-visible breakage: the site works
        // exactly as it did before service workers existed.
        warn("[sw] registration failed", { err });
      });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
