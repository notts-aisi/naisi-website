import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/*
 * pushSubscriptions/{id} — server-only collection, Admin SDK writes, no
 * client rules (Firestore's deny-by-default covers a collection no rule
 * matches; a documentation-only lock lives in firestore.rules).
 *
 * One doc per push subscription ENDPOINT, not per user. A subscription
 * belongs to a browser profile on a device, survives sign-out, and is
 * independent of auth state, so the uid on it is "who most recently claimed
 * this device", refreshed on every subscribe call. Do not key by uid: one
 * person has many devices, and a shared device changes hands.
 *
 * The doc id is a hash of the endpoint rather than the endpoint itself:
 * endpoints are URLs pushing 300 characters with slashes, and Firestore doc
 * ids cannot contain slashes.
 */

export type StoredSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  uid: string;
  userAgent?: string;
};

export function subscriptionDocId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 40);
}

export async function upsertSubscription(sub: StoredSubscription): Promise<boolean> {
  const db = getAdminDb();
  if (!db) return false;
  const ref = db.collection("pushSubscriptions").doc(subscriptionDocId(sub.endpoint));
  // Read-then-write rather than a blind merge, so createdAt survives the
  // routine re-subscribes (every app boot re-syncs, per the iOS rule that
  // pushsubscriptionchange never fires there). Contention on a single
  // device's own row is not a real concern.
  const existing = await ref.get();
  await ref.set(
    {
      endpoint: sub.endpoint,
      keys: sub.keys,
      uid: sub.uid,
      ...(sub.userAgent ? { userAgent: sub.userAgent } : {}),
      lastSeenAt: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  return true;
}

export async function deleteSubscriptionByEndpoint(
  endpoint: string,
  callerUid: string,
): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  const ref = db.collection("pushSubscriptions").doc(subscriptionDocId(endpoint));
  const doc = await ref.get();
  if (!doc.exists) return;
  // Only the device's current claimant may remove it, so one member cannot
  // silence another's device by guessing endpoints.
  if (doc.data()?.uid !== callerUid) return;
  await ref.delete();
}

/** Remove a dead subscription, called when a push service returns 404/410. */
export async function pruneSubscription(endpoint: string): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  await db.collection("pushSubscriptions").doc(subscriptionDocId(endpoint)).delete();
}

export async function subscriptionsForUid(uid: string): Promise<StoredSubscription[]> {
  const db = getAdminDb();
  if (!db) return [];
  const snap = await db.collection("pushSubscriptions").where("uid", "==", uid).get();
  return snap.docs
    .map((d) => d.data() as StoredSubscription)
    .filter((s) => typeof s.endpoint === "string" && s.keys?.p256dh && s.keys?.auth);
}
