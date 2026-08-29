"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { getInstallPlatform, isStandaloneNow } from "@/lib/pwa/displayMode";
import { mark, warn } from "@/lib/devMonitor";
import styles from "./PushSettings.module.css";

/*
 * Per-device notification opt-in, on /profile.
 *
 * "Per-device" is the operative idea and the copy leans into it: a push
 * subscription belongs to this browser on this hardware, not to the account.
 * It survives sign-out, does not follow the member to their laptop, and on
 * iOS exists only inside the installed app.
 *
 * States, in the order they are checked:
 *   - VAPID public key absent from the build: render nothing at all (the
 *     feature is unprovisioned; showing a dead control would be worse).
 *   - Browser has no push APIs: render nothing.
 *   - iOS but NOT installed: explain that notifications need the installed
 *     app. This is Apple's rule, not ours, and the one place the card shows
 *     with no button.
 *   - Permission previously denied: explain it must be unblocked in browser
 *     or system settings; we cannot re-ask.
 *   - Otherwise: the enable/disable/test controls.
 *
 * Two rules from the platform findings, both load-bearing:
 *   - subscribe() is called ONLY from the button's tap handler. Safari
 *     silently ignores permission requests that are not inside a genuine
 *     user gesture.
 *   - On mount, an EXISTING subscription is re-synced to the server. Safari
 *     iOS never fires pushsubscriptionchange, so re-asserting on every visit
 *     is the only way the server's record stays honest.
 */

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  // Explicit ArrayBuffer backing: TS 5.7 types a bare `new Uint8Array(n)`
  // over ArrayBufferLike, which BufferSource (what subscribe() takes)
  // rejects because it could be a SharedArrayBuffer.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State =
  | "unsupported"
  | "needs-install"
  | "denied"
  | "off"
  | "on"
  | "working";

export function PushSettings() {
  const [state, setState] = useState<State | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!PUBLIC_KEY) return; // renders nothing below
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
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
    let cancelled = false;
    void (async () => {
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

  const enable = useCallback(async () => {
    setState("working");
    setNote(null);
    try {
      // Must stay inside the tap's call stack far enough for Safari to
      // honour it; requestPermission is the gesture-gated step.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY!),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error(`subscribe ${res.status}`);
      mark("[push] enabled on this device");
      setState("on");
    } catch (err) {
      warn("[push] enable failed", { err });
      setNote("Could not enable notifications. Try again in a moment.");
      setState("off");
    }
  }, []);

  const disable = useCallback(async () => {
    setState("working");
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        void fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
      setState("off");
    } catch (err) {
      warn("[push] disable failed", { err });
      setState("on");
    }
  }, []);

  const sendTest = useCallback(async () => {
    setNote(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const body = (await res.json()) as { sent?: number };
      setNote(
        body.sent && body.sent > 0
          ? "Sent. It can take a few seconds to arrive."
          : "Nothing was sent. Try disabling and re-enabling notifications.",
      );
    } catch {
      setNote("The test could not be sent.");
    }
  }, []);

  if (!PUBLIC_KEY || state === null || state === "unsupported") return null;

  return (
    <Card padding="lg" className={styles.card}>
      <h2 className={styles.heading}>Notifications on this device</h2>
      {state === "needs-install" && (
        <p className={styles.copy}>
          iOS only delivers notifications to the installed app. Add NAISI to
          your home screen first (Share, then Add to Home Screen), then enable
          notifications from this page inside the app.
        </p>
      )}
      {state === "denied" && (
        <p className={styles.copy}>
          Notifications are blocked for this site. Unblock them in your browser
          or system settings, then come back here.
        </p>
      )}
      {(state === "off" || state === "on" || state === "working") && (
        <>
          <p className={styles.copy}>
            Notifications are per device: enabling them here covers this
            browser on this hardware only, and they keep arriving even when
            the app is closed.
          </p>
          <div className={styles.actions}>
            {state === "on" ? (
              <>
                <Button variant="secondary" onClick={() => void disable()}>
                  Turn off
                </Button>
                <Button variant="ghost" onClick={() => void sendTest()}>
                  Send a test
                </Button>
              </>
            ) : (
              <Button
                onClick={() => void enable()}
                disabled={state === "working"}
              >
                {state === "working" ? "Enabling…" : "Enable notifications"}
              </Button>
            )}
          </div>
        </>
      )}
      {note && <p className={styles.note}>{note}</p>}
    </Card>
  );
}
