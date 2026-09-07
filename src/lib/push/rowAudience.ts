import "server-only";

// The sibling imports below go through the `@/lib/push` alias rather than
// `./send` and `./config`, and that is load-bearing rather than a style choice:
// `tests/lib/tsLoader.mjs` keys its stubs on the specifier string exactly as
// written, and `tests/notice-lane.test.mjs` stubs `"./send"` to mean the EMAIL
// transport in `eventAnnouncement.ts`'s graph. Written relatively here, this
// module's push transport would silently be replaced by that email fake, which
// surfaces as a missing export at import time rather than as a failed test.
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
 * else theirs. A subscription collection over the ceiling below, or one that
 * cannot be read at all, is refused ENTIRELY, with nothing pushed: a truncation
 * would notify an arbitrary prefix of the audience and report success, which is
 * the one outcome a retry cannot repair.
 *
 * A COUNT OF ZERO IS FOUR DIFFERENT ANSWERS, so this returns a REFUSAL beside
 * it rather than a bare number. Nobody having opted in, the feature being
 * dormant for want of VAPID keys, an audience over the ceiling and a collection
 * that cannot be read all notify nobody, and only the last two are something a
 * sender should be told and could act on. The first two are silence by design
 * and carry a null refusal, so a screen that shows the refusal does not nag
 * about a backend where push simply is not provisioned.
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
 * THIS FILE IS THE AUTHORITY FOR THAT FIGURE, and ~34s is the number the three
 * places that cite it use: `dispatch.ts`, which carries the email side of the
 * same sum, `eventAnnouncement.ts`, and the newsletter send route. They
 * disagreed once, two of them saying ~20s from an earlier ceiling, and the way
 * that stays fixed is one file owning the arithmetic and the rest pointing at
 * it.
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

export type RowPushResult = {
  /** Accounts handed a notification. See "IT COUNTS NOTIFICATIONS" above. */
  pushed: number;
  /**
   * Why nobody was notified, when that is a fact a sender should be told. Null
   * for the two silences that are by design: no VAPID keys, and nobody opted in.
   */
  refusal: string | null;
};

export type RowPushOwners = {
  /** Distinct accounts with at least one registered device. */
  uids: string[];
  /** Why the enumeration answered nobody. Null for the two silences by design. */
  refusal: string | null;
};

/**
 * THE ENUMERATION ON ITS OWN: every account with at least one registered
 * device, deduped, with no send attached.
 *
 * Split out of {@link sendPushToRowAudience} when the event announcement grew a
 * SECOND caller with a different shape. That helper's loop is request-shaped:
 * it dispatches every owner inside one bounded pass and counts what got
 * through. The `event-announcements` scheduler job cannot use it, because its
 * unit of work is one owner under one marker, checked against the tick's
 * budget and resumed on the next tick. What the two genuinely share is the
 * scan and the ceiling reasoning, so that is what lives here and nothing else.
 *
 * NOT ROW-AWARE, deliberately. `pushSubscriptions` is one row per DEVICE with
 * the owning uid on it and nothing about preferences, so the row's cell is a
 * per-owner question the caller asks with `wantsPushFor`. Answering it here
 * would mean reading every owner's user document inside a function whose
 * callers then read them again.
 *
 * NEVER THROWS: a read that fails and a collection over the ceiling both come
 * back as a refusal, for the reason the header gives.
 */
export async function rowPushOwners(
  db: Firestore,
  log: { tag: string; reference: string },
  opts: { maxRows?: number } = {},
): Promise<RowPushOwners> {
  const maxRows = opts.maxRows ?? MAX_PUSH_ROWS;

  // Cheapest gate first: with no VAPID keys nothing pushes anywhere, and there
  // is no reason to read the collection. Not a refusal: the feature is dormant
  // until the secrets are provisioned (docs/pwa.md), and saying so on every
  // send would be noise about a decision nobody made today.
  if (!isPushConfigured()) return { uids: [], refusal: null };

  let snap;
  try {
    snap = await db.collection("pushSubscriptions").limit(maxRows + 1).get();
  } catch (err) {
    // The one read outside any per-account loop, and the one that used to
    // reject into the caller. Every caller says in its own header that it
    // never throws, and this is where that promise is kept.
    console.error(`[${log.tag}] push subscription read failed`, log.reference, err);
    return {
      uids: [],
      refusal:
        "The notification list could not be read, so nobody was notified by push. " +
        "The email went out as normal.",
    };
  }

  if (snap.docs.length > maxRows) {
    console.error(
      `[${log.tag}] push subscription count exceeds ceiling, not pushing`,
      log.reference,
      snap.docs.length,
    );
    return {
      uids: [],
      refusal:
        "There are more registered devices than one request can notify. " +
        "Nobody was notified by push: raise it with an admin.",
    };
  }

  return {
    uids: [
      ...new Set(
        snap.docs
          .map((d) => d.data()?.uid)
          .filter((uid): uid is string => typeof uid === "string" && uid.length > 0),
      ),
    ],
    refusal: null,
  };
}

/**
 * Push `notification` to every account with a device whose `row` cell is on.
 *
 * NEVER THROWS. Every failure it can have comes back as a count and a refusal,
 * because both callers are reporting something that has already happened by
 * email and neither may be turned into a 500 by a phone.
 *
 * @param log names the console lines this leg writes. `tag` is the sender's own
 *   bracketed prefix and `reference` the id of the thing being announced, never
 *   an address and never a name.
 */
export async function sendPushToRowAudience(
  db: Firestore,
  row: PushBroadcastRow,
  notification: PushNotification,
  log: { tag: string; reference: string },
): Promise<RowPushResult> {
  const owners = await rowPushOwners(db, log);
  if (owners.refusal !== null) return { pushed: 0, refusal: owners.refusal };
  const uids = owners.uids;

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
  return { pushed, refusal: null };
}
