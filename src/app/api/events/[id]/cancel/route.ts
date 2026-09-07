import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import EventCancelledEmail from "@/emails/EventCancelledEmail";
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
import { filterSuppressed } from "@/lib/firestore/suppression";
import { formatEventWhen } from "@/lib/events/changeSummary";
import { sendNoticePush } from "@/lib/push/noticeNotifications";

/**
 * Cancel a whole event. Sets status to "cancelled" and, when the organiser
 * ticked the notify box, tells every confirmed and waitlisted attendee through
 * the NOTICE LANE: an `EventCancelledEmail` framed as a cancellation rather
 * than a generic update, plus a notification to every attendee with an account.
 *
 * Routed through the Admin SDK because Firestore rules block client writes to
 * published events, and cancelling also needs to read attendee PII to send.
 * Gated to approvers + admins, matching the publish and update routes.
 *
 * ── WHY THE ATTENDEE NOTICE IS A NOTICE ─────────────────────────────────────
 * "The event you are coming to tonight is off" is the clearest case the class
 * has: the recipient asked for the event, the message is about that event, and
 * a notification grid switch must not be the reason somebody turns up to an
 * empty room. So it goes by email AND by push whatever their rows say, it
 * carries the marker line explaining why, and its receipt carries `kind:
 * "notice"` with `surface: "event-cancel"`. Suppression still applies: a
 * bounced address is a fact about an inbox, not a preference.
 *
 * ── THE CAP IS CLAIMED BEFORE THE CANCELLATION, NOT AFTER ───────────────────
 * The notice lane's caps bound how often one audience can be reached, and this
 * lane shares the event broadcast's counters, so an organiser who has already
 * sent today's ten notices can meet a refusal here. That refusal has to arrive
 * BEFORE the status write, or the answer would be "the event is cancelled and
 * nobody was told", which is the one outcome worse than either half. So the
 * slot is claimed first and a refused request changes nothing at all: the
 * organiser can retry, or untick "notify attendees" and cancel without a
 * message. The refusal sentence names the cap.
 */

const NOTE_MAX = 1000;

/**
 * WHICH RSVP STATUSES HEAR ABOUT A CANCELLATION. Confirmed attendees hold a
 * place; waitlisted attendees are one cancellation from holding one and would
 * otherwise keep waiting for an event that is not happening. `pending`,
 * `denied` and `cancelled` are out for the reasons the broadcast route gives.
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

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveEvent)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { notify?: unknown; note?: unknown };
  try {
    body = (await req.json()) as { notify?: unknown; note?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // Default the notify toggle on - the modal ticks it by default.
  const notify = body.notify !== false;
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";

  const ref = db.collection("events").doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = snap.data() ?? {};
  if (event.status === "cancelled") {
    return NextResponse.json(
      { error: "This event is already cancelled." },
      { status: 400 },
    );
  }

  // Notify confirmed + waitlisted attendees. Waitlisted are one cancellation
  // away from a spot, so they deserve to hear the event is off too.
  const rsvpSnap = notify
    ? await db
        .collection("eventRsvps")
        .where("eventId", "==", eventId)
        .where("status", "in", [...ATTENDING_STATUSES])
        .get()
    : null;

  const attendees: Attendee[] = [];
  let failed = 0;
  for (const doc of rsvpSnap?.docs ?? []) {
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

  // REFUSE, never truncate, and before anything is written. See the header.
  if (attendees.length > MAX_NOTICE_RECIPIENTS) {
    return NextResponse.json(
      {
        error: noticeRecipientRefusal(
          attendees.length,
          MAX_NOTICE_RECIPIENTS,
          "untick the notify box to cancel without a message, or raise it with an admin",
        ),
      },
      { status: 400 },
    );
  }

  // The slot is claimed BEFORE the cancellation, so a refusal leaves the event
  // exactly as it was rather than cancelled and unannounced. See the header.
  let slot = null;
  if (attendees.length > 0) {
    try {
      slot = await reserveNoticeSlots(db, {
        hour: {
          key: `eventnotice__${eventId}__${actor.uid}`,
          limit: NOTICES_PER_HOUR,
          windowMs: HOUR_MS,
        },
        day: { key: `eventnotice__${eventId}`, limit: NOTICES_PER_DAY, windowMs: DAY_MS },
        noun: "notices",
      });
    } catch (err) {
      // Fail CLOSED. A throttle that cannot be read is not a licence to send.
      console.error("[event cancel] throttle read failed", eventId, err);
      return NextResponse.json(
        { error: "Could not check the send limit. Try again in a moment." },
        { status: 500 },
      );
    }
    if (!slot.ok) {
      return NextResponse.json(
        {
          error:
            `${slot.refusal} The event has NOT been cancelled: try again, or untick ` +
            "the notify box to cancel without a message.",
        },
        { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
      );
    }
  }

  await ref.update({
    status: "cancelled",
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (!notify) {
    return NextResponse.json({ ok: true, notified: false, sent: 0 });
  }
  if (attendees.length === 0) {
    return NextResponse.json({
      ok: true,
      notified: true,
      sent: 0,
      failed,
      suppressed: 0,
      pushed: 0,
    });
  }

  const whenLine = formatEventWhen(
    event.startAt?.toDate?.() ?? null,
    event.endAt?.toDate?.() ?? null,
  );
  const eventTitle = (event.title ?? "NAISI event").toString();
  const eventPath = `/events/${encodeURIComponent(eventId)}`;
  const instagramHandle = process.env.NAISI_INSTAGRAM_HANDLE || "notts.ai.safety";
  // Fall back to the monitored Reply-To inbox, never the send-only
  // SMTP_FROM_EMAIL (newsletter@naisi.uk has no receiving MX).
  const contactEmail =
    process.env.NAISI_CONTACT_EMAIL ||
    process.env.EMAIL_DEFAULT_REPLY_TO ||
    "ai-safety@uonsu.com";

  const { suppressed: suppressedList } = await filterSuppressed(
    db,
    attendees.map((a) => a.address),
  );
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));
  const deliverable = attendees.filter((a) => !suppressedSet.has(a.address.toLowerCase()));
  const suppressed = attendees.length - deliverable.length;

  let sent = 0;
  await dispatchSends(deliverable, async (attendee) => {
    try {
      // ONE address. One message. Batching would disclose every attendee's
      // address to every other attendee.
      await sendNotice({
        to: attendee.address,
        subject: `Event cancelled: ${eventTitle}`,
        surface: "event-cancel",
        actorUid: actor.uid,
        referenceId: eventId,
        fromName: "NAISI Events",
        render: (marker) =>
          EventCancelledEmail({
            notice: marker,
            eventTitle,
            recipientName: attendee.name || "there",
            whenLine,
            note: note || undefined,
            instagramHandle,
            contactEmail,
          }),
      });
      sent += 1;
    } catch (err) {
      // RSVP id only: an address must not reach the logs.
      console.error("[event cancel] send failed", eventId, attendee.rsvpId, err);
      failed += 1;
    }
  });

  // Push reaches every attendee with an account, INCLUDING one whose address is
  // suppressed: suppression is a fact about an inbox and says nothing about a
  // phone. Deduped, because one member can hold two RSVP rows on one event.
  const pushUids = [
    ...new Set(attendees.map((a) => a.uid).filter((uid): uid is string => Boolean(uid))),
  ];
  let pushed = 0;
  for (const uid of pushUids) {
    await sendNoticePush(uid, {
      title: `Cancelled: ${eventTitle}`,
      body: "This event is no longer taking place.",
      url: eventPath,
    });
    pushed += 1;
  }

  return NextResponse.json({
    ok: true,
    notified: true,
    sent,
    failed,
    suppressed,
    pushed,
  });
}
