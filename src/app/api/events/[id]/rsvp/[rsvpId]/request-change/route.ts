import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sanitizeSignupForm, type FormQuestion } from "@/lib/firestore/events";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { verifyRsvpToken } from "@/lib/events/rsvpToken";

/**
 * An attendee (or organiser) proposes an update to the answers they submitted
 * with their RSVP — typically a dietary tweak. The change is not applied until
 * an organiser reviews it via the attendee dashboard.
 *
 * Auth: signed-in organisers OR a valid RSVP token (so anonymous public
 * signups can request changes via the link in their confirmation email).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; rsvpId: string }> },
) {
  const { id: eventId, rsvpId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { answers?: unknown; t?: unknown } = {};
  try {
    body = (await req.json()) as { answers?: unknown; t?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const viewer = await getCurrentUser();
  const tokenCandidate = typeof body.t === "string" ? body.t : "";

  const eventRef = db.collection("events").doc(eventId);
  const rsvpRef = db.collection("eventRsvps").doc(rsvpId);

  const [eventSnap, rsvpSnap] = await Promise.all([eventRef.get(), rsvpRef.get()]);
  if (!eventSnap.exists) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }
  if (!rsvpSnap.exists) {
    return NextResponse.json({ error: "RSVP not found." }, { status: 404 });
  }

  const event = eventSnap.data() ?? {};
  const rsvp = rsvpSnap.data() ?? {};

  if (rsvp.eventId !== eventId) {
    return NextResponse.json({ error: "This RSVP doesn't belong to that event." }, { status: 400 });
  }
  if (rsvp.status === "cancelled" || rsvp.status === "denied") {
    return NextResponse.json(
      { error: "You can't change a cancelled or denied RSVP." },
      { status: 400 },
    );
  }

  const rsvpEmail = typeof rsvp.email === "string" ? rsvp.email : "";
  const tokenValid =
    tokenCandidate !== "" && rsvpEmail !== "" && verifyRsvpToken(rsvpId, rsvpEmail, tokenCandidate);
  const isOrganiser =
    !!viewer &&
    (viewer.role === "admin" ||
      viewer.permissions.approveEvent ||
      (viewer.permissions.draftEvent && event.authorUid === viewer.uid));
  const isOwnUid = !!viewer && typeof rsvp.uid === "string" && rsvp.uid === viewer.uid;

  if (!isOrganiser && !isOwnUid && !tokenValid) {
    return NextResponse.json({ error: "You can't modify this RSVP." }, { status: 403 });
  }

  const questions: FormQuestion[] = sanitizeSignupForm(event.signupForm);
  if (questions.length === 0) {
    return NextResponse.json(
      { error: "This event has no signup questions to update." },
      { status: 400 },
    );
  }

  const validated = validateAnswers(questions, body.answers);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  await rsvpRef.update({
    pendingAnswers: validated.answers,
    pendingAnswersRequestedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
}
