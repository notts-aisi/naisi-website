import { NextResponse } from "next/server";
import EventUpdateEmail from "@/emails/EventUpdateEmail";
import { sendEmail } from "@/lib/email/send";
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
 * Organiser broadcast — send a one-off update email (room change, reminder,
 * etc.) to every confirmed (and optionally waitlisted) attendee. Sends are
 * awaited so the caller gets a real success count; failures are tallied
 * per-recipient and returned rather than aborting the whole batch.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

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

  // Emailing attendees touches their PII, so it is gated to SU-recognised
  // committee and admins, matching the eventRsvps read rule.
  const canBroadcast =
    viewer.role === "admin" ||
    (viewer.role === "committee" && viewer.suRecognised);
  if (!canBroadcast) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const eventSnap = await db.collection("events").doc(eventId).get();
  if (!eventSnap.exists) return NextResponse.json({ error: "Event not found." }, { status: 404 });
  const event = eventSnap.data() ?? {};

  // Pull active recipients. Waitlisted attendees get the same email by default
  // (they're just one cancellation away from being confirmed).
  const statuses = includeWaitlisted ? ["confirmed", "waitlisted"] : ["confirmed"];
  const snap = await db
    .collection("eventRsvps")
    .where("eventId", "==", eventId)
    .where("status", "in", statuses)
    .get();

  if (snap.empty) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, suppressed: 0 });
  }

  const whenLine = formatEventWhen(
    event.startAt?.toDate?.() ?? null,
    event.endAt?.toDate?.() ?? null,
  );
  // Broadcasts only go to confirmed/waitlisted, who were approved and already
  // know the exact location — don't fuzz it here.
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

  const plannedAddresses = snap.docs
    .map((d) => (typeof d.data()?.email === "string" ? (d.data().email as string) : ""))
    .filter(Boolean);
  const { suppressed: suppressedList } = await filterSuppressed(db, plannedAddresses);
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));

  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  // Serialize sends to stay well under typical SMTP rate limits — NAISI events
  // are small (tens, not thousands), so throughput isn't a concern.
  for (const doc of snap.docs) {
    const rsvp = doc.data() ?? {};
    const to = typeof rsvp.email === "string" ? rsvp.email : "";
    const name = typeof rsvp.name === "string" ? rsvp.name : "";
    if (!to) {
      failed += 1;
      continue;
    }
    if (suppressedSet.has(to.toLowerCase())) {
      suppressed += 1;
      console.log("[event broadcast] suppressed:", to);
      continue;
    }
    let cancelUrl: string | undefined;
    let changeUrl: string | undefined;
    try {
      const token = signRsvpToken(doc.id, to);
      cancelUrl = buildCancelUrl(eventId, doc.id, token);
      changeUrl = buildChangeUrl(eventId, doc.id, token);
    } catch {
      /* token secret missing — skip self-service links */
    }
    try {
      await sendEmail({
        to,
        subject: `${subject}: ${eventTitle}`,
        fromName: "NAISI Events",
        react: EventUpdateEmail({
          eventTitle,
          recipientName: name || "there",
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
        kind: "broadcast",
        actorUid: viewer.uid,
        referenceId: eventId,
      });
      sent += 1;
    } catch (err) {
      console.error(`[event broadcast] send to ${to} failed`, err);
      failed += 1;
    }
  }

  return NextResponse.json({ ok: true, sent, failed, suppressed });
}
