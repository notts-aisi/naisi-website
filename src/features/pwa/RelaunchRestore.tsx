"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { isStandaloneNow } from "@/lib/pwa/displayMode";
import { mark } from "@/lib/devMonitor";
import { readLastRoute } from "./lastRoute";

/**
 * Returns an installed-app relaunch to where the member was.
 *
 * Fires ONLY when every one of these holds, which is what keeps it from
 * ever fighting a deliberate navigation:
 *
 *   - running as an installed app (a browser tab never restores);
 *   - this is the document's first route, not a client-side navigation
 *     back to "/" (someone tapping the brand link to go home must GO home);
 *   - the URL is exactly "/", with no query and no hash. A deep link from
 *     an email or a notification carries a path, so the guard makes those
 *     always win over restoration;
 *   - a fresh recorded route exists (under 7 days, authed area only, see
 *     lastRoute.ts).
 *
 * router.replace, not push, so Back from the restored page does not bounce
 * through the homepage it never really visited.
 *
 * If the session died while the app was backgrounded, the restored route
 * bounces through proxy.ts to /login?next=<route>, which is exactly the
 * right outcome: sign in, land where you were going.
 *
 * Renders nothing.
 */
export function RelaunchRestore() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const attempted = useRef(false);

  useEffect(() => {
    // First-effect-only: a later client-side navigation to "/" must stay.
    if (attempted.current) return;
    attempted.current = true;

    if (!isStandaloneNow()) return;
    if (pathname !== "/") return;
    if (searchParams.size > 0 || window.location.hash) return;

    const last = readLastRoute();
    if (!last || last === "/") return;

    mark("[relaunch] restoring last route", { last });
    router.replace(last);
    // The effect deps are deliberately empty of pathname/searchParams: this
    // must evaluate the LAUNCH state once, not re-run as the app navigates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
