"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getInstallPlatform, isStandaloneNow } from "@/lib/pwa/displayMode";

/*
 * THE DEVICE'S PUSH STATE, LIFTED OUT OF THE CARD THAT USED TO OWN IT.
 *
 * Two surfaces on /profile need the same answer to "can this browser receive
 * a notification at all": the device card, which draws Enable / Turn off /
 * Send a test off it, and the notification grid's push column, which is
 * disabled with a hint whenever the answer is no. Running the environment
 * probe twice would mean two `serviceWorker.ready` waits, two
 * `getSubscription()` calls and two re-syncs of the same subscription on
 * every visit, and the two copies could disagree for as long as one of them
 * was still resolving. So the state machine lives here, once, and both read
 * it.
 *
 * The two load-bearing rules from the platform findings are kept exactly as
 * the card had them:
 *
 *   - `subscribe()` is called ONLY from the button's tap handler, which is
 *     why enabling still lives in the card and this provider exposes a setter
 *     rather than an `enable()` of its own. Safari silently ignores a
 *     permission request that is not inside a genuine user gesture, and a
 *     gesture does not survive being handed through a context.
 *   - On mount, an EXISTING subscription is re-synced to the server. Safari
 *     on iOS never fires `pushsubscriptionchange`, so re-asserting on every
 *     visit is the only way the server's record stays honest.
 *
 * `state === null` means the probe has not finished. That is NOT "off": the
 * grid treats it as "not on" (so the column is disabled while we do not yet
 * know) and the card renders nothing at all, exactly as it did before.
 */

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export type PushDeviceState =
  | "unsupported"
  | "needs-install"
  | "denied"
  | "off"
  | "on"
  | "working";

export type PushDevice = {
  /** The state machine, or null while the environment is still being read. */
  state: PushDeviceState | null;
  /** False when the build carries no VAPID key: the feature is unprovisioned. */
  configured: boolean;
  /**
   * Whether the device card renders anything, and therefore whether the
   * grid's hint may link to it. One predicate rather than two copies of the
   * card's early return.
   */
  cardShown: boolean;
  /** The card's own transitions (enable, disable, working, failure). */
  setState: (next: PushDeviceState) => void;
};

/**
 * The value outside a provider: unprovisioned and silent. A surface rendered
 * without the provider therefore draws its push column disabled rather than
 * offering switches that could never deliver anything.
 */
const OUTSIDE: PushDevice = {
  state: null,
  configured: false,
  cardShown: false,
  setState: () => {},
};

const PushDeviceContext = createContext<PushDevice>(OUTSIDE);

export function usePushDevice(): PushDevice {
  return useContext(PushDeviceContext);
}

/** The id the grid's hint links to, carried by the device card. */
export const PUSH_DEVICE_CARD_ID = "push-device";

export function PushDeviceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PushDeviceState | null>(null);

  useEffect(() => {
    if (!PUBLIC_KEY) return; // nothing to probe; the card renders nothing
    let cancelled = false;
    // Everything, including the synchronous environment checks, runs after a
    // microtask so the effect body itself never sets state synchronously
    // (the repo's set-state-in-effect lint). The user cannot perceive one
    // microtask of extra "render nothing".
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        setState("unsupported");
        return;
      }
      if (getInstallPlatform() === "ios" && !isStandaloneNow()) {
        setState("needs-install");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (sub) {
          setState("on");
          // Re-sync: keeps uid + lastSeenAt honest, since iOS never
          // announces subscription changes. Fire and forget.
          void fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subscription: sub.toJSON() }),
          }).catch(() => {});
        } else {
          setState("off");
        }
      } catch {
        if (!cancelled) setState("unsupported");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = useCallback((next: PushDeviceState) => setState(next), []);

  const value = useMemo<PushDevice>(
    () => ({
      state,
      configured: Boolean(PUBLIC_KEY),
      cardShown: Boolean(PUBLIC_KEY) && state !== null && state !== "unsupported",
      setState: set,
    }),
    [set, state],
  );

  return (
    <PushDeviceContext.Provider value={value}>{children}</PushDeviceContext.Provider>
  );
}
