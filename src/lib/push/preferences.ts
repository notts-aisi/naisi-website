import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  normaliseNotifications,
  resolveRow,
  wantsPush,
  type PushNotificationKey,
} from "@/lib/firestore/notifications";

/*
 * The server's read of a member's push switches.
 *
 * One helper, used by every mirror, so the three decisions below are made
 * once rather than per caller.
 *
 * ABSENT IS THE DEFAULT, NOT A REFUSAL, for the opt-out rows.
 * `normaliseNotifications` resolves an unwritten `push` map to `courses` and
 * `tasks` on, which is what keeps today's task and decision mirrors working
 * for every member who has enabled a device and never visited the switches.
 * The `newsletter` and `events` rows are opt-in and resolve off, because a
 * switch nobody has seen is not consent.
 *
 * A MISSING USER DOC RESOLVES THE ROW'S DEFAULT, the same answer an absent
 * cell gets: yes on `courses` and `tasks`, no on `newsletter` and `events`.
 * Until 7 September 2026 this branch answered yes on every row, on the
 * reasoning that the only accounts in that state were deleted ones, whose
 * `pushSubscriptions` rows `deleteAccount` removes in the same pass, so the
 * answer never reached a device. That held for a sender addressing a uid it
 * already knew and not for one that enumerates DEVICES: the event
 * announcement, and any producer built the same way, reaches this branch for
 * every device row whose owner's document is gone, and would have pushed an
 * opt-in row's notification to somebody who never opted in. So the branch now
 * goes through `resolveRow` like every other absent answer, and the table in
 * docs/notifications.md has one rule for the whole column.
 *
 * A FAILED READ IS A NO. If Firestore cannot answer, we do not know whether
 * this member opted out, and the cost of the two answers is not symmetric: a
 * dropped push loses nothing (the email that it mirrors is still sent),
 * while a push to somebody who switched them off is the one thing this
 * preference exists to prevent. So the error path fails closed and says so
 * in the log.
 */
export async function wantsPushFor(
  uid: string,
  key: PushNotificationKey,
): Promise<boolean> {
  const db = getAdminDb();
  if (!db) return false;
  try {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) return resolveRow(key, undefined);
    const profile = (snap.data()?.profile ?? {}) as {
      notifications?: unknown;
      newsletter?: unknown;
    };
    return wantsPush(normaliseNotifications(profile), key);
  } catch (err) {
    console.warn("[push] preference read failed, not pushing", { uid, key, err });
    return false;
  }
}
