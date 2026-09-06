import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  normaliseNotifications,
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
 * The `newsletter` and `events` rows are opt-in and resolve off, because
 * nothing pushes for them yet and a switch nobody has seen is not consent.
 *
 * A MISSING USER DOC IS ALSO THE DEFAULT. There is no stored preference to
 * honour, and the only people in that state are accounts whose doc has been
 * deleted; their subscriptions go with them, so the send finds no devices
 * anyway.
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
    if (!snap.exists) return true;
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
