import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { dispatchSends } from "@/lib/email/dispatch";
import type { PushNotificationKey } from "@/lib/firestore/notifications";
import { isPushConfigured } from "@/lib/push/config";
import { wantsPushFor } from "@/lib/push/preferences";
import { sendPushToUid, type PushNotification } from "@/lib/push/send";

/**
 * A WHOLE ROW'S PUSH AUDIENCE: every account with a device whose cell for that
 * row is on.
 *
 * This enumeration was written inside the new-event announcement and moved here
 * the day the newsletter row grew a producer of its own, because the two are
 * the same act and every reason the shape is what it is, is a reason about the
 * DATA rather than about events. `pushSubscriptions` is one row per DEVICE with
 * the owning uid on it, and there is no "members who want this row" index to
 * read, so the cheapest correct enumeration is the collection's uids, deduped,
 * then one preference read each. That is one collection scan plus one document
 * read per distinct account with a device, which for a society of this size is
 * tens of reads; anything cheaper would mean denormalising the cell onto the
 * subscription row and keeping two copies of one answer in step.
 *
 * ONLY THE TWO OPT-IN ROWS MAY BE ENUMERATED THIS WAY, which is what the
 * narrowed row parameter says. `newsletter` and `events` resolve OFF when their
 * cell is absent, so a scan of every device reaches only the accounts that have
 * answered yes. `courses` and `tasks` resolve ON when absent, so the same scan
 * would notify every account that has ever enabled a device, nearly all of whom
 * have nothing to do with the run or the task in hand. Those two rows are
 * addressed by uid instead, by the mirrors that ride beside their emails, and
 * that is a property of their defaults rather than an accident of who wrote
 * them first.
 *
 * IT COUNTS NOTIFICATIONS, NOT CALLS. An account whose cell is on but whose
 * only device has since been pruned is not somebody who was told, so the count
 * this returns is accounts that took at least one notification. A caller
 * counting attempts would report a full audience reached on a backend where
 * VAPID is unprovisioned and nothing left the building.
 *
 * BEST EFFORT PER ACCOUNT, AND A REFUSAL WHOLE. A push that throws for one
 * member is logged by uid and costs that member their notification and nobody
 * else theirs. A subscription collection over the ceiling below is refused
 * ENTIRELY, with nothing pushed: a truncation would notify an arbitrary prefix
 * of the audience and report success, which is the one outcome a retry cannot
 * repair.
 *
 * The caller owns the destination and it must be a same-origin PATH: the
 * service worker hands it to `clients.openWindow` unexamined.
 */

/**
 * Sanity ceiling on the push fan-out. `pushSubscriptions` holds one row per
 * DEVICE, so this is devices and not people; the loop below runs once per
 * distinct OWNER, which is at most that many.
 *
 * Sized against App Hosting's 60s request budget on this leg's own per-item
 * cost: an owner costs a preference read, a subscription read and a web-push
 * POST, ~0.4s pessimistically, where an email costs a render and an SMTP
 * connection. 500 owners is ceil(500/6) = 84 rounds x 0.4s = ~34s worst.
 *
 * That fits ALONGSIDE an email leg rather than after it, and both callers
 * dispatch it that way for exactly this reason: the event announcement runs
 * this concurrently with its ~36s email leg (see `sendEventAnnouncement`), and
 * the newsletter send runs it concurrently with a sequential send loop that is
 * the tightest wall clock in the estate. Run in series the two worst cases ADD
 * and neither request has anything left for its own reads. Over the ceiling
 * this leg goes quiet and says so in the log; the email still goes.
 */
export const MAX_PUSH_ROWS = 500;

/**
 * The rows whose audience is "every account with a device whose cell is on".
 *
 * Narrower than `PushNotificationKey` on purpose, and the narrowing is the
 * honest half of the header above: the two opt-out rows cannot be addressed by
 * enumerating devices, because an unanswered cell on those rows reads as yes.
 */
export type PushBroadcastRow = Extract<PushNotificationKey, "newsletter" | "events">;

/**
 * Push `notification` to every account with a device whose `row` cell is on.
 *
 * @param log names the console lines this leg writes. `tag` is the sender's own
 *   bracketed prefix and `reference` the id of the thing being announced, never
 *   an address and never a name.
 * @returns the number of accounts handed a notification.
 */
export async function sendPushToRowAudience(
  db: Firestore,
  row: PushBroadcastRow,
  notification: PushNotification,
  log: { tag: string; reference: string },
): Promise<number> {
  // Cheapest gate first: with no VAPID keys nothing pushes anywhere, and there
  // is no reason to read the collection.
  if (!isPushConfigured()) return 0;

  const snap = await db.collection("pushSubscriptions").limit(MAX_PUSH_ROWS + 1).get();
  if (snap.docs.length > MAX_PUSH_ROWS) {
    console.error(
      `[${log.tag}] push subscription count exceeds ceiling, not pushing`,
      log.reference,
      snap.docs.length,
    );
    return 0;
  }

  const uids = [
    ...new Set(
      snap.docs
        .map((d) => d.data()?.uid)
        .filter((uid): uid is string => typeof uid === "string" && uid.length > 0),
    ),
  ];

  let pushed = 0;
  await dispatchSends(uids, async (uid) => {
    try {
      // The row's PUSH cell, which is opt-in on both rows this helper serves:
      // absent resolves OFF, so nobody is pushed for having an account.
      if (!(await wantsPushFor(uid, row))) return;
      const counts = await sendPushToUid(uid, notification);
      // Notifications, not calls: see the header.
      if (counts.sent > 0) pushed += 1;
    } catch (err) {
      // Best effort, always. Uid only.
      console.warn(`[${log.tag}] push failed`, log.reference, uid, err);
    }
  });
  return pushed;
}
