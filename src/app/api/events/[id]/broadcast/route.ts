import { NextResponse } from "next/server";
import EventUpdateEmail from "@/emails/EventUpdateEmail";
import { dispatchSends } from "@/lib/email/dispatch";
import { sendNotice } from "@/lib/email/notice";
import {
  DAY_MS,
  HOUR_MS,
  MAX_NOTICE_RECIPIENTS,
  NOTICES_PER_DAY,
  NOTICES_PER_HOUR,
  noticeRecipientRefusal,
  reserveNoticeSlots,
} from "@/lib/email/noticeCaps";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  baseUrl,
  cancelUrl as buildCancelUrl,
  changeUrl as buildChangeUrl,
  signRsvpToken,
} from "@/lib/events/rsvpToken";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { formatEventWhen, parseEventChanges } from "@/lib/events/changeSummary";
import { sendNoticePush } from "@/lib/push/noticeNotifications";

type BroadcastPayload = {
  subject?: unknown;
  body?: unknown;
  /** Whether to include waitlisted attendees in addition to confirmed. Default true. */
  includeWaitlisted?: unknown;
  /** Optional notify-worthy change diff, rendered as a struck-through summary. */
  changes?: unknown;
  /** Whether the rich-text description changed (can't be diffed inline). */
  descriptionChanged?: unknown;
};

const SUBJECT_MAX = 150;
const BODY_MAX = 8000;

/**
 * ORGANISER BROADCAST, and the events half of the NOTICE LANE.
 *
 * A one-off update to everyone holding a place at an event: the room moved, the
 * speaker is late, bring a laptop. It also carries the post-publish change
 * notice `EventEditor` sends after an edit to a published event, over the diff
 * `update/route.ts` returns, which is the same message with the diff attached.
 *
 * ── WHY IT IS A NOTICE, AND WHAT THAT COSTS ─────────────────────────────────
 * The notification grid gives every member four rows and two columns, and this
 * send reads none of them. A person who signed up for an event has asked to be
 * told about that event, and an organiser who cannot reach their own attendees
 * has no way to run the evening. So this goes out by email AND by push whatever
 * the recipient's switches say, and the price of that exception is paid in
 * three places: the email carries a visible marker line saying why it reached
 * them (`sendNotice` builds it), the receipt carries `kind: "notice"` and
 * `surface: "event-broadcast"` so the deliverability tab can show what
 * bypassed, and the caps below bound how often it can happen. Suppression is
 * NOT bypassed: a bounce or a complaint is a fact about an address, not a
 * preference, and no class of message outranks it.
 *
 * ── WHO MAY SEND ────────────────────────────────────────────────────────────
 * Admins, the event's AUTHOR, anyone in its `collaboratorUids`, or SU-recognised
 * committee. The last of those was the whole gate until this lane landed, and
 * it had a hole shaped like the person most likely to need it: the committee
 * member who organised the event could not mail its attendees unless the SU had
 * separately recognised them. An author and their named collaborators are the
 * people responsible for the event, which is exactly the notice class's
 * predicate, as long as they still hold an approved account, which is what
 * `approvedAccount` below insists on.
 *
 * AUTHORIZATION BEFORE EXISTENCE, in the courses routes' ordering: the event is
 * read first because the gate depends on it, and a caller who is none of the
 * four gets one indistinguishable 403 whether or not the id exists.
 *
 * ── THE AUDIENCE IS DERIVED HERE AND NEVER HANDED BACK ──────────────────────
 * RSVP addresses are PII that `firestore.rules` restricts to SU-recognised
 * committee and admins, and this gate now admits people who are neither. So the
 * caller supplies no addresses and no uids, the audience comes off the event's
 * own RSVP rows server side, and the response is COUNTS ONLY. The console lines
 * carry the RSVP row id, never the address, for the same reason.
 *
 * ── ONE MESSAGE PER RECIPIENT ───────────────────────────────────────────────
 * One `sendNotice` per address, a single string as `to`, no Cc and no Bcc.
 * Batching an event's attendees into one envelope would disclose every
 * attendee's address to every other attendee.
 */

/**
 * WHICH RSVP STATUSES COUNT AS ATTENDING.
 *
 * `confirmed` holds a place. `waitlisted` is one cancellation away from holding
 * one, so a room change reaches them by default and the composer's tick is what
 * drops them. The other three are deliberately out: `pending` has asked and not
 * yet been approved, so they are not attending anything yet and an "our room
 * moved" would be the first they heard of a place they may not get; `denied`
 * and `cancelled` are not coming. The same list decides who is pushed.
 */
const ATTENDING_STATUSES = ["confirmed", "waitlisted"] as const;

type Attendee = {
  /** RSVP row id. What the logs name, in place of an address. */
  rsvpId: string;
  address: string;
  name: string;
  /** Null for a guest who RSVP'd without an account: email only, no push. */
  uid: string | null;
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // AUTHORIZATION BEFORE EXISTENCE. The event is read first because the gate
  // reads its author and collaborators; a caller who passes none of the four
  // tests gets a 403 whether or not the id names anything.
  const eventSnap = await db.collection("events").doc(eventId).get();
  const event = eventSnap.exists ? (eventSnap.data() ?? {}) : null;
  const authorUid = typeof event?.authorUid === "string" ? event.authorUid : "";
  const collaboratorUids = Array.isArray(event?.collaboratorUids)
    ? (event.collaboratorUids as unknown[]).filter(
        (uid): uid is string => typeof uid === "string",
      )
    : [];
  // AN APPROVED ACCOUNT ONLY. `getCurrentUser` hands back a session for every
  // role, `pending` and `rejected` included, and an account's name stays on
  // every event it ever authored. Without this test an account that was
  // rejected, or that never got past `pending`, would keep the right to mail
  // the attendee lists of its old events: addresses it can no longer so much
  // as read, since `firestore.rules` restricts `eventRsvps` to SU-recognised
  // committee and admins. Being named on an event is a responsibility, not a
  // standing credential. A member demoted off the committee still passes,
  // deliberately: they are still an approved member and still the person
  // responsible for the event their name is on.
  const approvedAccount =
    viewer.role === "member" || viewer.role === "committee" || viewer.role === "admin";
  const responsibleForEvent =
    approvedAccount &&
    event !== null &&
    Boolean(viewer.uid) &&
    (viewer.uid === authorUid || collaboratorUids.includes(viewer.uid));
  const canBroadcast =
    viewer.role === "admin" ||
    responsibleForEvent ||
    (viewer.role === "committee" && viewer.suRecognised);
  if (!canBroadcast) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  if (!event) return NextResponse.json({ error: "Event not found." }, { status: 404 });

  let payload: BroadcastPayload;
  try {
    payload = (await req.json()) as BroadcastPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subject =
    typeof payload.subject === "string" ? payload.subject.trim().slice(0, SUBJECT_MAX) : "";
  const body =
    typeof payload.body === "string" ? payload.body.trim().slice(0, BODY_MAX) : "";
  const includeWaitlisted = payload.includeWaitlisted !== false;
  const changes = parseEventChanges(payload.changes);
  const descriptionChanged = payload.descriptionChanged === true;

  if (!subject) return NextResponse.json({ error: "Subject is required." }, { status: 400 });
  if (!body) return NextResponse.json({ error: "Message body is required." }, { status: 400 });

  const statuses = includeWaitlisted ? [...ATTENDING_STATUSES] : ["confirmed"];
  const snap = await db
    .collection("eventRsvps")
    .where("eventId", "==", eventId)
    .where("status", "in", statuses)
    .get();

  if (snap.empty) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, suppressed: 0, pushed: 0 });
  }

  // REFUSE, never truncate, and refuse BEFORE a rate-limit slot is claimed. A
  // partial send is the worst outcome available here because it looks like a
  // whole one: an arbitrary three hundred get the mail, the report says three
  // hundred sent and none skipped, and the retry re-mails the same three
  // hundred.
  if (snap.docs.length > MAX_NOTICE_RECIPIENTS) {
    return NextResponse.json(
      {
        error: noticeRecipientRefusal(
          snap.docs.length,
          MAX_NOTICE_RECIPIENTS,
          "split the audience or raise it with an admin",
        ),
      },
      { status: 400 },
    );
  }

  const whenLine = formatEventWhen(
    event.startAt?.toDate?.() ?? null,
    event.endAt?.toDate?.() ?? null,
  );
  // Broadcasts only go to confirmed/waitlisted, who were approved and already
  // know the exact location, so it is not fuzzed here.
  const locationLine = (event.location ?? "Location to be confirmed").toString();
  const instagramHandle =
    process.env.NAISI_INSTAGRAM_HANDLE || "notts.ai.safety";
  // Fall back to the monitored Reply-To inbox, never the send-only
  // SMTP_FROM_EMAIL (newsletter@naisi.uk has no receiving MX).
  const contactEmail =
    process.env.NAISI_CONTACT_EMAIL ||
    process.env.EMAIL_DEFAULT_REPLY_TO ||
    "ai-safety@uonsu.com";
  const eventTitle = (event.title ?? "NAISI event").toString();
  // Public event page, linked from the "description has been updated" line.
  const eventUrl = `${baseUrl()}/events/${eventId}`;
  const eventPath = `/events/${encodeURIComponent(eventId)}`;

  let failed = 0;
  const attendees: Attendee[] = [];
  for (const doc of snap.docs) {
    const rsvp = doc.data() ?? {};
    const address = typeof rsvp.email === "string" ? rsvp.email.trim() : "";
    if (!address) {
      failed += 1;
      continue;
    }
    attendees.push({
      rsvpId: doc.id,
      address,
      name: typeof rsvp.name === "string" ? rsvp.name : "",
      uid: typeof rsvp.uid === "string" && rsvp.uid ? rsvp.uid : null,
    });
  }

  const { suppressed: suppressedList } = await filterSuppressed(
    db,
    attendees.map((a) => a.address),
  );
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));
  const deliverable = attendees.filter((a) => !suppressedSet.has(a.address.toLowerCase()));
  const suppressed = attendees.length - deliverable.length;

  // Push goes to every attendee with an account, INCLUDING one whose address is
  // suppressed: suppression is a fact about an inbox and says nothing about a
  // phone. The uid set is deduped because one member can hold two RSVP rows on
  // one event (a cancelled one and a live one) and must not buzz twice.
  const pushUids = [...new Set(attendees.map((a) => a.uid).filter((uid): uid is string => Boolean(uid)))];

  if (deliverable.length === 0 && pushUids.length === 0) {
    // Nothing to send: do not spend a rate-limit slot on it.
    return NextResponse.json({ ok: true, sent: 0, failed, suppressed, pushed: 0 });
  }

  // THE CAPS, claimed immediately before dispatch and spent whether or not the
  // dispatch finishes (reserve-before-send: a request that dies half way
  // through has already delivered part of the mail).
  let slot;
  try {
    slot = await reserveNoticeSlots(db, {
      hour: {
        key: `eventnotice__${eventId}__${viewer.uid}`,
        limit: NOTICES_PER_HOUR,
        windowMs: HOUR_MS,
      },
      day: { key: `eventnotice__${eventId}`, limit: NOTICES_PER_DAY, windowMs: DAY_MS },
      noun: "notices",
    });
  } catch (err) {
    // Fail CLOSED. A throttle that cannot be read is not a licence to send.
    console.error("[event broadcast] throttle read failed", eventId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      { error: slot.refusal },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  let sent = 0;
  // Bounded concurrency: `dispatchSends` carries the wall-clock arithmetic
  // against App Hosting's 60s request ceiling, which the slot above has already
  // been spent against by the time the loop starts.
  await dispatchSends(deliverable, async (attendee) => {
    let cancelUrl: string | undefined;
    let changeUrl: string | undefined;
    try {
      const token = signRsvpToken(attendee.rsvpId, attendee.address);
      cancelUrl = buildCancelUrl(eventId, attendee.rsvpId, token);
      changeUrl = buildChangeUrl(eventId, attendee.rsvpId, token);
    } catch {
      /* token secret missing: skip the self-service links */
    }
    try {
      // ONE address. One message. See the module comment.
      await sendNotice({
        to: attendee.address,
        subject: `${subject}: ${eventTitle}`,
        surface: "event-broadcast",
        actorUid: viewer.uid,
        referenceId: eventId,
        fromName: "NAISI Events",
        render: (marker) =>
          EventUpdateEmail({
            notice: marker,
            eventTitle,
            recipientName: attendee.name || "there",
            whenLine,
            locationLine,
            subject,
            body,
            changes,
            descriptionChanged,
            eventUrl,
            cancelUrl,
            changeUrl,
            instagramHandle,
            contactEmail,
          }),
      });
      sent += 1;
    } catch (err) {
      // RSVP id only: an address must not reach the logs.
      console.error("[event broadcast] send failed", eventId, attendee.rsvpId, err);
      failed += 1;
    }
  });

  let pushed = 0;
  for (const uid of pushUids) {
    // `sendNoticePush` never throws and reads no preference. A member with no
    // device gets nothing here and the email alone, which is why `pushed`
    // counts what it ANSWERED rather than what was called: on a backend with no
    // VAPID keys every call is a silent no-op and a count of calls would report
    // a whole audience notified.
    const buzzed = await sendNoticePush(uid, {
      title: eventTitle,
      body: subject,
      url: eventPath,
    });
    if (buzzed) pushed += 1;
  }

  return NextResponse.json({ ok: true, sent, failed, suppressed, pushed });
}
