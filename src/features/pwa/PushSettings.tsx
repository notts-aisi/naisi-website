"use client";

import { useCallback, useEffect, useState } from "react";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Switch from "@/components/ui/Switch";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  ALL_PUSH_KEYS,
  PUSH_DESCRIPTIONS,
  PUSH_LABELS,
  normaliseNotifications,
  serialisePush,
  setPushPreference,
  type NotificationPrefs,
  type PushNotificationKey,
} from "@/lib/firestore/notifications";
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
 *
 * The ACCOUNT-LEVEL topic switches (`PushTopics` below) are a SIBLING card,
 * not a section of this one, and /profile renders both. They were nested here
 * once and that was a bug: this card returns null on any environment without a
 * VAPID key and on any browser without push, so nesting them made two account
 * settings unreachable everywhere the feature is not yet provisioned. The two
 * settings answer different questions and only one of them is about hardware.
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
    let cancelled = false;
    // Everything, including the synchronous environment checks, runs after a
    // microtask so the effect body itself never sets state synchronously
    // (the repo's set-state-in-effect lint). The user cannot perceive one
    // microtask of extra "render nothing".
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
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
    // The route may hold the request for ~12s while it waits out the push
    // service's fresh-subscription lag, so say something meanwhile.
    setNote("Sending…");
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const body = (await res.json()) as { sent?: number; deferred?: number };
      if (body.sent && body.sent > 0) {
        setNote("Sent. It can take a few seconds to arrive.");
      } else if (body.deferred && body.deferred > 0) {
        setNote(
          "This device registered moments ago and the push service is still catching up. Try again in a few seconds.",
        );
      } else {
        setNote("Nothing was sent. Try disabling and re-enabling notifications.");
      }
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

/**
 * The account-level topic switches, rendered on /profile as their own card.
 *
 * INDEPENDENT OF THIS DEVICE, and therefore of `PushSettings`. The only gates
 * are a signed-in user and a resolved read of their stored preference. A
 * member on a laptop where push is blocked, or on any browser at all before
 * the VAPID secrets are provisioned, is still saying something true about the
 * phone they have enabled, so hiding these behind the per-device card would
 * hide an account setting behind unrelated hardware.
 *
 * SAVED ON TOGGLE, not behind a Save button, and that is the difference
 * between this and the notification preferences on the profile form. The
 * write goes to the same place a profile save goes, `users/{uid}`, under the
 * `profile.notifications.push` field path so it touches neither `channels`
 * nor `categories` (the profile form owns those, and carries this map through
 * untouched when it writes).
 *
 * ABSENT MEANS ON. `normaliseNotifications` resolves an unwritten map to both
 * switches on, which is exactly what the member has already consented to by
 * enabling notifications on a device, so nothing is stored until they turn
 * one off.
 */
export function PushTopics() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const db = getClientDb();
    return onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        const profile = (snap.data()?.profile ?? {}) as {
          notifications?: unknown;
          newsletter?: unknown;
        };
        setPrefs(normaliseNotifications(profile));
      },
      // A read that fails leaves the switches hidden rather than showing a
      // default that is not the member's stored answer.
      (err) => {
        warn("[push] topic preferences unreadable", { err });
        setPrefs(null);
      },
    );
  }, [user]);

  const onToggle = useCallback(
    async (key: PushNotificationKey, next: boolean) => {
      if (!user || !prefs) return;
      const previous = prefs;
      // The shared setter, so the "touch one key, leave channels and
      // categories alone" rule lives in one tested place rather than in an
      // object spread here.
      const updated = setPushPreference(prefs, key, next);
      setPrefs(updated);
      setError(null);
      try {
        await updateDoc(doc(getClientDb(), "users", user.uid), {
          "profile.notifications.push": serialisePush(updated.push),
        });
      } catch (err) {
        warn("[push] saving topic preference failed", { err });
        setPrefs(previous);
        setError("That did not save. Try again in a moment.");
      }
    },
    [prefs, user],
  );

  if (!user || !prefs) return null;

  return (
    <Card padding="lg" className={styles.card}>
      <h2 className={styles.heading}>Notifications</h2>
      <p className={styles.topicsEyebrow}>All your devices, not just this one</p>
      <div className={styles.topicsRows}>
        {ALL_PUSH_KEYS.map((key) => (
          <Switch
            key={key}
            checked={prefs.push[key]}
            onChange={(next) => void onToggle(key, next)}
            label={PUSH_LABELS[key]}
            description={PUSH_DESCRIPTIONS[key]}
          />
        ))}
      </div>
      <p className={styles.topicsNote}>
        Turning one off stops the notification, never the email.
      </p>
      {error && <p className={styles.topicsError}>{error}</p>}
    </Card>
  );
}
