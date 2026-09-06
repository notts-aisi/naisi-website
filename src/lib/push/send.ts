import "server-only";

import webpush from "web-push";
import { getVapidKeys, VAPID_SUBJECT } from "./config";
import { pruneSubscription, subscriptionsForUid, type StoredSubscription } from "./store";

/*
 * The one sending pipeline. Everything that pushes goes through here so the
 * three non-negotiables live in exactly one place:
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
 *
 * 3. ...except while the subscription is brand new. Measured against FCM on
 *    2026-08-29: a subscription that Chrome had just created answered
 *    410 "push subscription has unsubscribed or expired" at t+0s, t+3s and
 *    t+6s, then 201 at t+9s, and it delivered fine from then on. The push
 *    service's send frontend simply lags its subscribe frontend by a few
 *    seconds. Without a grace window the very first thing a member does,
 *    "Enable notifications" then "Send a test", hit that lag every time and
 *    the prune then DELETED the row they had just registered, so the device
 *    looked unregistered until their next /profile visit re-synced it. So a
 *    404/410 inside PRUNE_GRACE_MS of the row's createdAt is treated as
 *    "deferred": the notification is dropped (task mirrors) or retried after
 *    a pause (the self-test), and the row is left alone.
 */

export type PushNotification = {
  title: string;
  body: string;
  /** Same-origin path the notification tap lands on. */
  url: string;
};

export type SendOutcome = "sent" | "pruned" | "deferred" | "failed";

/** Final outcome per subscription, plus how many retries it took to get there. */
export type SendCounts = Record<SendOutcome, number> & { retried: number };

/**
 * How long after a row's createdAt a 404/410 is NOT believed. The measured
 * lag is under ten seconds; two minutes costs nothing (a genuinely dead
 * subscription created that recently is pruned on the next send instead)
 * and covers a slower push service having a bad day.
 */
export const PRUNE_GRACE_MS = 2 * 60 * 1000;

/**
 * The self-test's retry schedule for a deferred send: three more tries four
 * seconds apart, so a test fired the instant after enabling still lands
 * inside a normal request budget (the measured lag clears by ~9s).
 */
const FRESH_RETRY_ATTEMPTS = 3;
const FRESH_RETRY_DELAY_MS = 4000;

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

function isWithinGrace(sub: StoredSubscription, now = Date.now()): boolean {
  // A row with no createdAt (pre-dating the field) gets no grace: it is
  // certainly not seconds old.
  if (!sub.createdAt) return false;
  return now - sub.createdAt.getTime() < PRUNE_GRACE_MS;
}

async function sendToSubscription(
  sub: StoredSubscription,
  n: PushNotification,
): Promise<SendOutcome> {
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
      if (isWithinGrace(sub)) return "deferred";
      await pruneSubscription(sub.endpoint);
      return "pruned";
    }
    // No status means the request never got an HTTP answer (socket error,
    // timeout); the message is the only clue, so log it. Never the endpoint.
    console.warn("[push] send failed", {
      status,
      message: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Push to every device a member has enabled. Returns per-outcome counts.
 *
 * `retryFresh` re-attempts a deferred send a few times with a pause between,
 * for callers that are happy to wait (the self-test). Task mirrors leave it
 * off: a push that coincides with the first seconds of a subscription's
 * life is dropped rather than holding a task route open.
 */
export async function sendPushToUid(
  uid: string,
  n: PushNotification,
  { retryFresh = false }: { retryFresh?: boolean } = {},
): Promise<SendCounts> {
  const counts: SendCounts = { sent: 0, pruned: 0, deferred: 0, failed: 0, retried: 0 };
  if (!ensureConfigured()) return counts;
  const subs = await subscriptionsForUid(uid);
  for (const sub of subs) {
    let outcome = await sendToSubscription(sub, n);
    if (retryFresh) {
      for (let i = 0; i < FRESH_RETRY_ATTEMPTS && outcome === "deferred"; i++) {
        await sleep(FRESH_RETRY_DELAY_MS);
        counts.retried += 1;
        outcome = await sendToSubscription(sub, n);
      }
    }
    counts[outcome] += 1;
  }
  return counts;
}
