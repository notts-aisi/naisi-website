import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import EventCancelledEmail from "@/emails/EventCancelledEmail";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { formatEventWhen } from "@/lib/events/changeSummary";

/**
 * Cancel a whole event. Sets status to "cancelled" and, when the organiser
 * ticked the notify box, emails every confirmed and waitlisted attendee an
 * EventCancelledEmail (framed as a cancellation, not a generic update).
 *
 * Routed through the Admin SDK because Firestore rules block client writes to
 * published events, and cancelling also needs to read attendee PII to send.
 * Gated to approvers + admins, matching the publish and update routes.
 */

const NOTE_MAX = 1000;

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

  await ref.update({
    status: "cancelled",
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (!notify) {
    return NextResponse.json({ ok: true, notified: false, sent: 0 });
  }

  // Notify confirmed + waitlisted attendees. Waitlisted are one cancellation
  // away from a spot, so they deserve to hear the event is off too.
  const rsvpSnap = await db
    .collection("eventRsvps")
    .where("eventId", "==", eventId)
    .where("status", "in", ["confirmed", "waitlisted"])
    .get();

  if (rsvpSnap.empty) {
    return NextResponse.json({ ok: true, notified: true, sent: 0, failed: 0, suppressed: 0 });
  }

  const whenLine = formatEventWhen(
    event.startAt?.toDate?.() ?? null,
    event.endAt?.toDate?.() ?? null,
  );
  const eventTitle = (event.title ?? "NAISI event").toString();
  const instagramHandle = process.env.NAISI_INSTAGRAM_HANDLE || "notts.ai.safety";
  // Fall back to the monitored Reply-To inbox, never the send-only
  // SMTP_FROM_EMAIL (newsletter@naisi.uk has no receiving MX).
  const contactEmail =
    process.env.NAISI_CONTACT_EMAIL ||
    process.env.EMAIL_DEFAULT_REPLY_TO ||
    "ai-safety@uonsu.com";

  const plannedAddresses = rsvpSnap.docs
    .map((d) => (typeof d.data()?.email === "string" ? (d.data().email as string) : ""))
    .filter(Boolean);
  const { suppressed: suppressedList } = await filterSuppressed(db, plannedAddresses);
  const suppressedSet = new Set(suppressedList.map((a) => a.toLowerCase()));

  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  // Serialize sends - NAISI events are small (tens, not thousands).
  for (const doc of rsvpSnap.docs) {
    const rsvp = doc.data() ?? {};
    const to = typeof rsvp.email === "string" ? rsvp.email : "";
    const name = typeof rsvp.name === "string" ? rsvp.name : "";
    if (!to) {
      failed += 1;
      continue;
    }
    if (suppressedSet.has(to.toLowerCase())) {
      suppressed += 1;
      console.log("[event cancel] suppressed:", to);
      continue;
    }
    try {
      await sendEmail({
        to,
        subject: `Cancelled: ${eventTitle}`,
        fromName: "NAISI Events",
        react: EventCancelledEmail({
          eventTitle,
          recipientName: name || "there",
          whenLine,
          note: note || undefined,
          instagramHandle,
          contactEmail,
        }),
        kind: "broadcast",
        actorUid: actor.uid,
        referenceId: eventId,
      });
      sent += 1;
    } catch (err) {
      console.error(`[event cancel] send to ${to} failed`, err);
      failed += 1;
    }
  }

  return NextResponse.json({ ok: true, notified: true, sent, failed, suppressed });
}
