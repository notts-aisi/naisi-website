import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import EventAnnouncementEmail from "@/emails/EventAnnouncementEmail";
import {
  addressesForSend,
  normaliseNotifications,
} from "@/lib/firestore/notifications";
import { findRecipientsForChannel } from "@/lib/firestore/subscriptions";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { sendPushToUid } from "@/lib/push/send";
import { isPushConfigured } from "@/lib/push/config";
import { wantsPushFor } from "@/lib/push/preferences";
import { signToken } from "@/lib/signedTokens";
import { dispatchSends } from "./dispatch";
import { sendEmail } from "./send";

/**
 * "WE HAVE PUBLISHED A NEW EVENT": the sender the `events` row was promising.
 *
 * The notification grid's events row has been collected on /register and
 * /profile since the subscriptions junction landed, and its copy promises "a
 * short email when we publish a new event". Nothing read it. A row that
 * promises a message nothing sends is worse than no row: it takes a real answer
 * from a member and does nothing with it. This is that message.
 *
 * ── IT IS THE GRID CLASS, ON BOTH COLUMNS, AND THEY ARE TWO ANSWERS ─────────
 * EMAIL goes to the `subscriptions` junction, exactly as the newsletter's does:
 * every confirmed-and-subscribed row on channel `events`, hydrated per member
 * through `addressesForSend`, which applies the events cell AND the per-address
 * gmail/uniEmail routing in one answer. The junction row IS the opt-in here,
 * which is why there is no second check: a row exists because somebody asked
 * for it, and `addressesForSend` returns an empty list for anybody whose cell
 * has since gone off.
 *
 * PUSH goes to the events PUSH cell, which is a different answer to a different
 * question and is opt-in (absent resolves OFF, see `resolveRow`). So the push
 * audience is not derived from the junction at all: it is every account with a
 * device whose `push.events` cell is on. A member can hold the email row and
 * refuse the push, or hold neither, or hold only the push, and all three are
 * respected because each column is asked separately.
 *
 * ── MEMBERS-ONLY EVENTS ─────────────────────────────────────────────────────
 * An event with `visibility: "members"` is not public, so a GUEST row on the
 * events channel (an address with no account, from the public subscribe form)
 * must not hear about it. Those rows are dropped and counted. User rows are
 * kept: they belong to accounts, which is the same bar the event page applies.
 * The push audience is accounts by construction, so it needs no equivalent
 * filter.
 *
 * ── IT MUST NEVER FAIL A PUBLISH ────────────────────────────────────────────
 * The caller publishes the event first and calls this afterwards. Everything
 * here is best effort and returns COUNTS: a channel that cannot be read, a
 * render that throws, a push service having a bad day. An event that went live
 * and did not get announced is a missing email; an announcement that turned a
 * publish into a 500 would be an event nobody can find on a page that says it
 * failed to save.
 */

/**
 * Sanity ceiling on the channel READ, which bounds the hydration behind it: one
 * `getAll` over the user rows. Over it the announcement is REFUSED before a
 * document is fetched. It is not the send ceiling; that is the next constant,
 * and it is counted on a different thing.
 */
export const MAX_ANNOUNCEMENT_ROWS = 500;

/**
 * THE SEND CEILING, COUNTED IN MESSAGES AND NOT IN JUNCTION ROWS.
 *
 * A row is not a message. A member with a verified university address on both
 * channels takes TWO sends, so a 500-row list is up to a thousand `sendEmail`
 * calls, and this whole announcement runs inside the publish REQUEST, against
 * `apphosting.yaml`'s `timeoutSeconds: 60`. `dispatch.ts` carries the
 * arithmetic; the figure it supports is 200 messages, the same number the run
 * composer's cap was sized to: ceil(200/6) = 34 rounds x 1.05s worst = ~36s,
 * ~19s typical.
 *
 * Counted AFTER hydration, on addresses, because that is the only count that is
 * the number of sends. A request over it is REFUSED, and refused loudly enough
 * that the publish route can hand the claim back (see its header): a truncation
 * would mail an arbitrary prefix of the list and report success, and a timeout
 * would do the same with no report at all.
 *
 * RAISING IT MEANS REDOING THE SUM IN `dispatch.ts`. A list that outgrows it
 * needs the send taken off the request path, which is a different feature.
 */
export const MAX_ANNOUNCEMENT_SENDS = 200;

/**
 * Sanity ceiling on the push fan-out. `pushSubscriptions` holds one row per
 * DEVICE, so this is devices and not people; the loop below runs once per
 * distinct OWNER, which is at most that many.
 *
 * Sized against the same 60s budget, on its own per-item cost: an owner costs a
 * preference read, a subscription read and a web-push POST, ~0.4s
 * pessimistically, where an email costs a render and an SMTP connection. 500
 * owners is ceil(500/6) = 84 rounds x 0.4s = ~34s worst, which fits ALONGSIDE
 * the email leg's ~36s because the two are dispatched CONCURRENTLY (see
 * `sendEventAnnouncement`): the request's wall clock is the larger of the two
 * rather than their sum. Over the ceiling the push leg goes quiet and says so
 * in the log; the email still goes.
 */
export const MAX_PUSH_ROWS = 500;

/** Same lifetime the newsletter gives its unsubscribe links. */
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

export type EventAnnouncementInput = {
  eventId: string;
  title: string;
  /** Formatted schedule line. The route formats it; this module never does. */
  whenLine: string;
  /** The PUBLIC location text: the placeholder when the real one is hidden. */
  locationLine: string;
  /** Absolute URL of the public event page. */
  eventUrl: string;
  coverImageUrl: string | null;
  /** True for `visibility: "members"`. Drops guest rows. See the header. */
  membersOnly: boolean;
  /** The uid of whoever published. The receipt's actor. */
  actorUid: string;
};

export type EventAnnouncementResult = {
  sent: number;
  /** Rows dropped: no address, an account gone, a members-only guest row. */
  skipped: number;
  suppressed: number;
  failed: number;
  /** Accounts handed a notification. A device may still have been absent. */
  pushed: number;
  /** Non-null when nothing was sent because the audience is unreadable. */
  refusal: string | null;
};

type Recipient = {
  /** Uid for a member row, "" for a guest row. Decides the unsubscribe token. */
  uid: string;
  audience: "user" | "guest";
  recipientName: string;
  /** The address the token addresses for a guest. */
  primaryEmail: string;
  addresses: string[];
};

/**
 * The email half. Returns counts and never throws for a per-recipient failure.
 */
async function announceByEmail(
  db: Firestore,
  input: EventAnnouncementInput,
): Promise<Omit<EventAnnouncementResult, "pushed">> {
  const rows = await findRecipientsForChannel(db, "events");

  // REFUSE rather than slice. A `slice()` here would be a silent truncation
  // wearing a cost-ceiling costume: dedupe runs after it, so a list with enough
  // second-address rows could fall under the cap having already lost people and
  // the send would look complete. The cohort resolver makes the same call for
  // the same reason.
  if (rows.length > MAX_ANNOUNCEMENT_ROWS) {
    console.error(
      "[event announcement] channel row count exceeds ceiling",
      input.eventId,
      rows.length,
    );
    return {
      sent: 0,
      skipped: 0,
      suppressed: 0,
      failed: 0,
      refusal:
        "The events list is larger than a single announcement can handle. " +
        "Nothing was sent: raise it with an admin.",
    };
  }

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  let skipped = 0;

  // Hydrate user rows once per uid: a member with two rows on one channel is a
  // defect, not a reason to read their document twice.
  const userIds = [
    ...new Set(rows.filter((r) => r.audience === "user").map((r) => r.audienceId)),
  ];
  const userDocs = userIds.length
    ? await db.getAll(...userIds.map((uid) => db.collection("users").doc(uid)))
    : [];
  const userById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  for (const snap of userDocs) {
    if (snap.exists) userById.set(snap.id, snap);
  }

  // Dedupe at the RECIPIENT level, not the address level: a member holding both
  // a user row and a stale guest row must get one email, not two.
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const row of rows) {
    const dedupKey = `${row.audience}:${row.audienceId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (row.audience === "user") {
      const snap = userById.get(row.audienceId);
      if (!snap) {
        // A subscribed row whose account is gone.
        skipped += 1;
        continue;
      }
      const data = snap.data() ?? {};
      const profile = (data.profile ?? {}) as Record<string, unknown>;
      const addresses = addressesForSend({
        prefs: normaliseNotifications(profile),
        category: "events",
        gmailEmail: (data.email as string | undefined) ?? null,
        universityEmail: (profile.universityEmail as string | undefined) ?? null,
        gmailOnlyMode: gmailOnly,
      });
      if (addresses.length === 0) {
        skipped += 1;
        continue;
      }
      recipients.push({
        uid: snap.id,
        audience: "user",
        recipientName:
          (profile.preferredName as string | undefined) ||
          (data.displayName as string | undefined) ||
          "there",
        primaryEmail: (data.email as string | undefined) ?? row.email,
        addresses,
      });
      continue;
    }

    // A guest: one address, no account, no name on file.
    if (input.membersOnly) {
      // Members-only event, so an address with no account is not an audience.
      skipped += 1;
      continue;
    }
    const address = row.email.trim();
    if (!address) {
      skipped += 1;
      continue;
    }
    recipients.push({
      uid: "",
      audience: "guest",
      recipientName: "there",
      primaryEmail: address,
      addresses: [address],
    });
  }

  if (recipients.length === 0) {
    return { sent: 0, skipped, suppressed: 0, failed: 0, refusal: null };
  }

  // THE SEND CEILING, ON ADDRESSES. See `MAX_ANNOUNCEMENT_SENDS`: a recipient
  // with two verified addresses is two messages, so this is the only count that
  // can be judged against the request's wall-clock budget. Refused before the
  // suppression read and before a single send, so nothing has gone out and the
  // publish route can hand the claim back.
  const messageCount = recipients.reduce((n, r) => n + r.addresses.length, 0);
  if (messageCount > MAX_ANNOUNCEMENT_SENDS) {
    console.error(
      "[event announcement] message count exceeds ceiling",
      input.eventId,
      messageCount,
    );
    return {
      sent: 0,
      skipped,
      suppressed: 0,
      failed: 0,
      refusal:
        `This announcement would send ${messageCount} emails, over the ` +
        `${MAX_ANNOUNCEMENT_SENDS} one publish can deliver inside a single request. ` +
        "Nothing was sent: raise it with an admin.",
    };
  }

  const { suppressed: suppressedList } = await filterSuppressed(
    db,
    recipients.flatMap((r) => r.addresses),
  );
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));

  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  // Bounded concurrency: `dispatchSends` carries the wall-clock arithmetic
  // against App Hosting's 60s request ceiling, and this runs inside the publish
  // request.
  await dispatchSends(recipients, async (recipient) => {
    // Members: the token addresses the UID, so one click flips the events rows
    // for both of their addresses. Guests: it addresses the email, flipping
    // their single row.
    const token =
      recipient.audience === "user"
        ? signToken({ s: "unsubscribe", uid: recipient.uid, c: "events" }, UNSUB_TOKEN_TTL_SECONDS)
        : signToken(
            { s: "unsubscribe", email: recipient.primaryEmail, c: "events" },
            UNSUB_TOKEN_TTL_SECONDS,
          );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(token)}`;

    for (const address of recipient.addresses) {
      if (suppressedSet.has(address.toLowerCase())) {
        suppressed += 1;
        continue;
      }
      try {
        await sendEmail({
          to: address,
          subject: `New event: ${input.title}`,
          fromName: "NAISI Events",
          react: EventAnnouncementEmail({
            eventTitle: input.title,
            recipientName: recipient.recipientName,
            whenLine: input.whenLine,
            locationLine: input.locationLine,
            eventUrl: input.eventUrl,
            coverImageUrl: input.coverImageUrl,
            unsubscribeUrl,
          }),
          kind: "event-announcement",
          actorUid: input.actorUid,
          referenceId: input.eventId,
          listUnsubscribe: {
            url: unsubscribeUrl,
            mailto: process.env.EMAIL_DEFAULT_REPLY_TO,
          },
        });
        sent += 1;
      } catch (err) {
        // Uid or audience only: an address must not reach the logs.
        console.error(
          "[event announcement] send failed",
          input.eventId,
          recipient.uid || recipient.audience,
          err,
        );
        failed += 1;
      }
    }
  });

  return { sent, skipped, suppressed, failed, refusal: null };
}

/**
 * The push half: every account with a device whose events push cell is on.
 *
 * `pushSubscriptions` is one row per DEVICE with the owning uid on it, and
 * there is no "members who want event pushes" index to read, so the cheapest
 * correct enumeration is the collection's uids, deduped, then one preference
 * read each. That is one collection scan plus one document read per distinct
 * account with a device, which for a society of this size is tens of reads;
 * anything cheaper would mean denormalising the cell onto the subscription row
 * and keeping two copies of one answer in step.
 */
async function announceByPush(
  db: Firestore,
  input: EventAnnouncementInput,
): Promise<number> {
  // Cheapest gate first: with no VAPID keys nothing pushes anywhere, and there
  // is no reason to read the collection.
  if (!isPushConfigured()) return 0;

  const snap = await db.collection("pushSubscriptions").limit(MAX_PUSH_ROWS + 1).get();
  if (snap.docs.length > MAX_PUSH_ROWS) {
    console.error(
      "[event announcement] push subscription count exceeds ceiling, not pushing",
      input.eventId,
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

  const path = `/events/${encodeURIComponent(input.eventId)}`;
  let pushed = 0;
  await dispatchSends(uids, async (uid) => {
    try {
      // The events PUSH cell, which is opt-in: absent resolves OFF, so nobody
      // is pushed for having an account.
      if (!(await wantsPushFor(uid, "events"))) return;
      const counts = await sendPushToUid(uid, {
        title: "New NAISI event",
        body: input.title,
        url: path,
      });
      // Notifications, not calls: an account whose cell is on but whose only
      // device has since been pruned is not somebody who was told.
      if (counts.sent > 0) pushed += 1;
    } catch (err) {
      // Best effort, always. Uid only.
      console.warn("[event announcement] push failed", input.eventId, uid, err);
    }
  });
  return pushed;
}

/**
 * Announce a published event. Best effort: returns counts, never throws.
 *
 * THE TWO LEGS RUN CONCURRENTLY, and that is a budget decision rather than a
 * tidiness one. Both are bounded loops inside the 60s publish request, they
 * share no state, and they answer two different questions to two different
 * audiences; run in series their worst cases ADD (~36s + ~20s) and leave the
 * request nothing for its own reads. Run together the wall clock is the larger
 * of the two. A refusal on one leg says nothing about the other: an events list
 * too large to mail does not stop the push audience being told.
 */
export async function sendEventAnnouncement(
  db: Firestore,
  input: EventAnnouncementInput,
): Promise<EventAnnouncementResult> {
  const [email, pushed] = await Promise.all([
    announceByEmail(db, input),
    announceByPush(db, input),
  ]);
  return { ...email, pushed };
}
