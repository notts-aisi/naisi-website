import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Organiser approves an attendee's proposed answer change. Copies
 * `pendingAnswers` into `answers`, clears the pending field.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; rsvpId: string }> },
) {
  const { id: eventId, rsvpId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const rsvpRef = db.collection("eventRsvps").doc(rsvpId);
  const eventRef = db.collection("events").doc(eventId);
  const [rsvpSnap, eventSnap] = await Promise.all([rsvpRef.get(), eventRef.get()]);
  if (!rsvpSnap.exists) return NextResponse.json({ error: "RSVP not found." }, { status: 404 });
  if (!eventSnap.exists) return NextResponse.json({ error: "Event not found." }, { status: 404 });

  const rsvp = rsvpSnap.data() ?? {};
  const event = eventSnap.data() ?? {};
  if (rsvp.eventId !== eventId) {
    return NextResponse.json({ error: "This RSVP doesn't belong to that event." }, { status: 400 });
  }

  const isOrganiser =
    viewer.role === "admin" ||
    viewer.permissions.approveEvent ||
    (viewer.permissions.draftEvent && event.authorUid === viewer.uid);
  if (!isOrganiser) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (!rsvp.pendingAnswers) {
    return NextResponse.json(
      { error: "No pending change to approve." },
      { status: 400 },
    );
  }

  await rsvpRef.update({
    answers: rsvp.pendingAnswers,
    pendingAnswers: FieldValue.delete(),
    pendingAnswersRequestedAt: FieldValue.delete(),
  });

  return NextResponse.json({ ok: true });
}
