import "server-only";

import webpush from "web-push";
import { getVapidKeys, VAPID_SUBJECT } from "./config";
import { pruneSubscription, subscriptionsForUid, type StoredSubscription } from "./store";

/*
 * The one sending pipeline. Everything that pushes goes through here so the
 * two non-negotiables live in exactly one place:
 *
 * 1. The payload is the Declarative Web Push envelope (`web_push: 8030` with
 *    a `notification` member). Safari 18.4+ renders it with NO service
 *    worker JS at all, which is structurally immune to the silent-push trap;
 *    Chromium and Firefox wake our sw.js handler, which reads the same
 *    envelope. One payload, both worlds.
 *
 * 2. Dead subscriptions are pruned on 404/410. Safari iOS never fires
 *    pushsubscriptionchange, so the server return codes are the ONLY signal
 *    a device is gone.
 */

export type PushNotification = {
  title: string;
  body: string;
  /** Same-origin path the notification tap lands on. */
  url: string;
};

let vapidConfigured = false;

function ensureConfigured(): boolean {
  const keys = getVapidKeys();
  if (!keys) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    vapidConfigured = true;
  }
  return true;
}

function envelope(n: PushNotification): string {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: n.title,
      body: n.body,
      navigate: n.url,
    },
  });
}

async function sendToSubscription(
  sub: StoredSubscription,
  n: PushNotification,
): Promise<"sent" | "pruned" | "failed"> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      envelope(n),
      // Give phones a chance to fetch it after coming off a dead zone.
      { TTL: 60 * 60 * 24 },
    );
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await pruneSubscription(sub.endpoint);
      return "pruned";
    }
    console.warn("[push] send failed", { status });
    return "failed";
  }
}

/** Push to every device a member has enabled. Returns per-outcome counts. */
export async function sendPushToUid(
  uid: string,
  n: PushNotification,
): Promise<{ sent: number; pruned: number; failed: number }> {
  const counts = { sent: 0, pruned: 0, failed: 0 };
  if (!ensureConfigured()) return counts;
  const subs = await subscriptionsForUid(uid);
  for (const sub of subs) {
    counts[await sendToSubscription(sub, n)] += 1;
  }
  return counts;
}
