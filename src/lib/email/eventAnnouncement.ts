import "server-only";
import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import EventAnnouncementEmail from "@/emails/EventAnnouncementEmail";
import {
  addressesForSend,
  normaliseNotifications,
} from "@/lib/firestore/notifications";
import { findRecipientsForChannel } from "@/lib/firestore/subscriptions";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { sendPushToRowAudience, type RowPushResult } from "@/lib/push/rowAudience";
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
 * is sent by the `event-announcements` scheduler job instead, which is the
 * feature that took the send off the request path; see
 * {@link MAX_QUEUED_ANNOUNCEMENT_ROWS}.
 */
export const MAX_ANNOUNCEMENT_SENDS = 200;

/**
 * The JOB PATH's ceiling on the same channel read, and the reason it is ten
 * times the request path's.
 *
 * There is no message ceiling on the job path at all, and that is the whole
 * point of the move: the job's unit of work is one recipient under one marker,
 * it checks the tick's wall clock between units, and it resumes on the next
 * tick, reading its markers in bulk so a settled recipient costs a set lookup
 * rather than three round trips. A list up to THIS ceiling therefore goes out,
 * over as many ticks as it takes. Not a list of any size: the ceiling below is
 * the bound, and it is on the READ rather than on the sending.
 *
 * What survives is a sanity ceiling on the junction READ, because that read is
 * NOT paged: `findRecipientsForChannel` fetches every confirmed-and-subscribed
 * row on the channel in one go, and the `getAll` over the user rows behind it
 * is proportional to the result. 5000 rows is far above any shape this society
 * plans and comfortably inside one Firestore read, and a list past it is
 * REFUSED whole rather than truncated, exactly as the request path refuses:
 * an arbitrary prefix that reports success is the one outcome a retry cannot
 * repair. Paging the read is the fix if the list ever genuinely approaches it,
 * and it would need a stable order to page on, which the junction has no index
 * for today.
 */
export const MAX_QUEUED_ANNOUNCEMENT_ROWS = 5000;

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
  /**
   * The PUSH leg's own refusal, kept separate from the email leg's because the
   * two legs fail independently: a list too large to mail says nothing about
   * whether the phones were notified, and reporting one refusal for both would
   * tell the publisher the wrong thing about half the announcement.
   */
  pushRefusal: string | null;
};

export type AnnouncementRecipient = {
  /** Uid for a member row, "" for a guest row. Decides the unsubscribe token. */
  uid: string;
  audience: "user" | "guest";
  recipientName: string;
  /** The address the token addresses for a guest. */
  primaryEmail: string;
  addresses: string[];
};

/** What the audience read found, or the reason it found nothing. */
export type AnnouncementAudience = {
  recipients: AnnouncementRecipient[];
  /** Rows dropped: no address, an account gone, a members-only guest row. */
  skipped: number;
  /** Non-null when the list could not be resolved. Nothing was sent. */
  refusal: string | null;
};

/**
 * ONE RECIPIENT'S STABLE KEY, for the scheduler job's per-recipient marker.
 *
 * A member is their uid, prefixed `u` so the two namespaces cannot collide. A
 * guest has no id, only an address, and an address cannot be the key: a marker
 * id may carry no `.` (see `assertDocIdComponent`), and a marker lives for six
 * months in a collection whose whole purpose is to say "this was sent", which
 * is no place to accumulate a mailing list. So a guest is `g` plus the first
 * 16 hex characters of the SHA-256 of their normalised address: stable across
 * ticks, derivable by anybody holding the address, and not a mailing list.
 *
 * Sixteen hex characters is 64 bits. The birthday bound on that is around four
 * billion keys, against an audience the ceiling above caps at five thousand,
 * so a collision here is not a risk being accepted; it is a number that cannot
 * be reached.
 */
export function announcementRecipientKey(recipient: AnnouncementRecipient): string {
  if (recipient.audience === "user") return `u${recipient.uid}`;
  const digest = createHash("sha256")
    .update(recipient.primaryEmail.trim().toLowerCase(), "utf8")
    .digest("hex");
  return `g${digest.slice(0, 16)}`;
}

/**
 * THE AUDIENCE, RESOLVED ONCE AND SHARED BY BOTH PATHS.
 *
 * The junction read, the row ceiling, the per-uid hydration through
 * `addressesForSend`, the recipient-level dedupe and the members-only drop.
 * Every one of those is a fact about WHO the events row is, and none of them is
 * a fact about whether the send is happening inside the publish request or on a
 * scheduler tick. Two copies of this would be two answers to "who is on the
 * events list", which is the drift the whole grid exists to end.
 *
 * `maxRows` is the ONE thing the two paths disagree about, and they disagree
 * about it honestly: the request path is bounded by a 60s timeout it cannot
 * exceed, the job path by a tick's budget it can simply resume from. See
 * {@link MAX_ANNOUNCEMENT_ROWS} and {@link MAX_QUEUED_ANNOUNCEMENT_ROWS}.
 *
 * NEVER THROWS for anything it can decide: a list over the ceiling comes back
 * as a refusal with an empty audience. A Firestore read that rejects DOES
 * propagate, because a caller that cannot tell "nobody is subscribed" from
 * "the database is down" would report a successful announcement to an empty
 * room, and both callers catch it.
 */
export async function resolveAnnouncementAudience(
  db: Firestore,
  input: EventAnnouncementInput,
  opts: { maxRows?: number } = {},
): Promise<AnnouncementAudience> {
  const maxRows = opts.maxRows ?? MAX_ANNOUNCEMENT_ROWS;
  const rows = await findRecipientsForChannel(db, "events");

  // REFUSE rather than slice. A `slice()` here would be a silent truncation
  // wearing a cost-ceiling costume: dedupe runs after it, so a list with enough
  // second-address rows could fall under the cap having already lost people and
  // the send would look complete. The cohort resolver makes the same call for
  // the same reason.
  if (rows.length > maxRows) {
    console.error(
      "[event announcement] channel row count exceeds ceiling",
      input.eventId,
      rows.length,
    );
    return {
      recipients: [],
      skipped: 0,
      refusal:
        "The events list is larger than a single announcement can handle. " +
        "Nothing was sent: raise it with an admin.",
    };
  }

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";

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
  const recipients: AnnouncementRecipient[] = [];
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

  return { recipients, skipped, refusal: null };
}

/**
 * ONE RECIPIENT'S ANNOUNCEMENT, on every address they take, and the whole of
 * what "sending the announcement" means to a person.
 *
 * Shared by both paths for the reason the resolver above is: the unsubscribe
 * token's shape (uid for a member so one click drops both their addresses, the
 * address for a guest because it is the only handle they have), the subject,
 * the template and the receipt's `kind` are all facts about the MESSAGE rather
 * than about which side of the request boundary it left from.
 *
 * NEVER THROWS. A send that fails is counted and logged by uid or audience,
 * never by address, so a whole audience is not lost to one bad mailbox.
 *
 * `suppressed` is handed in rather than read here, and that is a real
 * difference between the two callers rather than an oversight: the request
 * path reads the suppression list ONCE for the whole audience (one `getAll`,
 * inside its wall-clock sum), while the job reads it per recipient, because
 * its recipient is its unit of work and a list-wide read would be work thrown
 * away the moment the tick's budget ran out.
 */
export async function sendAnnouncementToRecipient(
  input: EventAnnouncementInput,
  recipient: AnnouncementRecipient,
  suppressed: ReadonlySet<string>,
): Promise<{ sent: number; suppressed: number; failed: number }> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
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

  const counts = { sent: 0, suppressed: 0, failed: 0 };
  for (const address of recipient.addresses) {
    if (suppressed.has(address.toLowerCase())) {
      counts.suppressed += 1;
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
      counts.sent += 1;
    } catch (err) {
      // Uid or audience only: an address must not reach the logs.
      console.error(
        "[event announcement] send failed",
        input.eventId,
        recipient.uid || recipient.audience,
        err,
      );
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * The email half of the INLINE path. Returns counts and never throws for a
 * per-recipient failure.
 */
async function announceByEmail(
  db: Firestore,
  input: EventAnnouncementInput,
): Promise<Omit<EventAnnouncementResult, "pushed" | "pushRefusal">> {
  const audience = await resolveAnnouncementAudience(db, input);
  if (audience.refusal !== null) {
    return {
      sent: 0,
      skipped: audience.skipped,
      suppressed: 0,
      failed: 0,
      refusal: audience.refusal,
    };
  }
  const { recipients, skipped } = audience;

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
    const counts = await sendAnnouncementToRecipient(input, recipient, suppressedSet);
    sent += counts.sent;
    suppressed += counts.suppressed;
    failed += counts.failed;
  });

  return { sent, skipped, suppressed, failed, refusal: null };
}

/**
 * The push half: every account with a device whose events push cell is on.
 *
 * The enumeration itself lives in `src/lib/push/rowAudience.ts`, because the
 * newsletter send asks the same question of a different row and one of the two
 * copies would have drifted. What stays here is the part that is about events:
 * which row, what the notification says, and where a tap lands.
 */
function announceByPush(
  db: Firestore,
  input: EventAnnouncementInput,
): Promise<RowPushResult> {
  return sendPushToRowAudience(
    db,
    "events",
    {
      title: "New NAISI event",
      body: input.title,
      url: `/events/${encodeURIComponent(input.eventId)}`,
    },
    { tag: "event announcement", reference: input.eventId },
  );
}

/**
 * Announce a published event. Best effort: returns counts, never throws.
 *
 * THE TWO LEGS RUN CONCURRENTLY, and that is a budget decision rather than a
 * tidiness one. Both are bounded loops inside the 60s publish request, they
 * share no state, and they answer two different questions to two different
 * audiences; run in series their worst cases ADD (~36s here plus the ~34s
 * `rowAudience.ts` sizes for the push leg, which is the authority for that
 * figure) and leave the request nothing for its own reads. Run together the
 * wall clock is the larger of the two. A refusal on one leg says nothing about
 * the other, which is why they are reported separately: an events list too
 * large to mail does not stop the push audience being told.
 */
export async function sendEventAnnouncement(
  db: Firestore,
  input: EventAnnouncementInput,
): Promise<EventAnnouncementResult> {
  const [email, push] = await Promise.all([
    announceByEmail(db, input),
    announceByPush(db, input),
  ]);
  return { ...email, pushed: push.pushed, pushRefusal: push.refusal };
}
