"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { useIsStandalone } from "@/hooks/useDisplayMode";
import { mark, warn } from "@/lib/devMonitor";
import { hardNavigate } from "@/lib/navigation/hardNavigate";
import { claimStaleSessionRepair } from "@/lib/navigation/selfHealGuard";

/**
 * Repairs the inverse of the passive self-heal: a valid __session cookie with
 * NO Firebase Auth user on the client.
 *
 * AuthEntry already handles the forward case (a live Firebase session with no
 * cookie) by re-minting. This is the mirror image, and until now nothing
 * handled it. Reaching (app)/layout.tsx proves getCurrentUser() accepted the
 * cookie server-side, so the server renders the shell for a real member while
 * the client has nobody signed in. Every one of the 41 onSnapshot listeners
 * then fails permission-denied, silently, and the user sits looking at an app
 * that renders but never fills in.
 *
 * How you get there:
 *   - iOS gives an installed home-screen app its own storage partition. The
 *     cookie jar and Firebase Auth's IndexedDB do not come across from Safari
 *     together, so a first launch can arrive with one and not the other.
 *     Safari 26 opens every Home Screen addition as a web app by default, so
 *     this is reachable in production today, with or without a manifest.
 *   - WebKit bug 272325: home-screen web apps losing session cookies
 *     non-deterministically.
 *   - Any browser where IndexedDB is cleared but cookies are not.
 *
 * TWO GUARDS, both load-bearing:
 *
 * 1. `authResolved`, not `!loading`. AuthProvider flips `loading` false either
 *    when onAuthStateChanged fires OR when its 3-second failsafe gives up on a
 *    wedged SDK, and in the second case `user` is null because we could not
 *    find out. Healing on `!loading && !user` would clear the session cookie
 *    of a genuinely signed-in member on a slow or jammed client, on every
 *    authed page load. `authResolved` is true only for the real listener.
 *
 * 2. Standalone only, for now. The failure is overwhelmingly a home-screen-app
 *    one, and this is the sort of repair that should earn its way to every
 *    visitor rather than start there. Widening it is a one-line change once
 *    there is evidence it behaves.
 *
 * The repair clears the cookie via a route that does NOT revoke refresh
 * tokens, then does a full document load to /login. See the docblock on
 * /api/auth/session/clear for why revoking would be wrong here.
 *
 * Renders nothing.
 */
export function SessionSanityGuard() {
  const { user, authResolved } = useAuth();
  const isStandalone = useIsStandalone();
  const pathname = usePathname();
  // Belt and braces alongside the sessionStorage claim: survives a re-render,
  // where the sessionStorage window survives a document load.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    if (!isStandalone) return;
    if (!authResolved) return;
    if (user !== null) return;

    if (!claimStaleSessionRepair()) {
      warn("[session-sanity] repair already attempted, not looping", { pathname });
      return;
    }
    handled.current = true;

    mark("[session-sanity] cookie present, no Firebase user — clearing", { pathname });
    void (async () => {
      try {
        await fetch("/api/auth/session/clear", { method: "POST" });
      } catch (err) {
        // Even if the clear fails, sending them to /login is better than
        // leaving them on a shell whose every listener is denied.
        warn("[session-sanity] clear failed, redirecting anyway", { err });
      }
      hardNavigate(`/login?next=${encodeURIComponent(pathname)}`);
    })();
  }, [user, authResolved, isStandalone, pathname]);

  return null;
}
