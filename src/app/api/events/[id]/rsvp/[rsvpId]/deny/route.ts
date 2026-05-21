import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sendRsvpEmail } from "@/lib/events/sendRsvpEmail";

/**
 * Organiser action: deny a pending RSVP. Accepts an optional free-text note
 * kept on the RSVP for the audit trail (not surfaced to the attendee yet —
 * notification email is Phase 4).
 *
 * Transition: pending → denied. No capacity changes.
 *
 * Gated to: event author (draftEvent), approvers, admins.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; rsvpId: string }> },
) {
  const { id: eventId, rsvpId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let note = "";
  try {
    const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
    if (body && typeof body.note === "string") note = body.note.trim().slice(0, 500);
  } catch {
    /* empty body is fine */
  }

  const rsvpRef = db.collection("eventRsvps").doc(rsvpId);
  const eventRef = db.collection("events").doc(eventId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap = await tx.get(eventRef);
      if (!rsvpSnap.exists) throw new DenyError("RSVP not found.", 404);
      if (!eventSnap.exists) throw new DenyError("Event not found.", 404);

      const rsvp = rsvpSnap.data() ?? {};
      const event = eventSnap.data() ?? {};

      if (rsvp.eventId !== eventId) {
        throw new DenyError("This RSVP doesn't belong to that event.", 400);
      }

      const isApprover =
        viewer.role === "admin" ||
        viewer.permissions.approveEvent ||
        (viewer.permissions.draftEvent && event.authorUid === viewer.uid);
      if (!isApprover) throw new DenyError("You can't deny this RSVP.", 403);

      if (rsvp.status !== "pending") {
        throw new DenyError(`Only pending RSVPs can be denied (was "${rsvp.status}").`, 400);
      }

      const pending = typeof event.rsvpCountPending === "number" ? event.rsvpCountPending : 0;

      tx.update(rsvpRef, {
        status: "denied",
        decisionNote: note || null,
        decidedBy: viewer.uid,
        decidedAt: FieldValue.serverTimestamp(),
      });
      tx.update(eventRef, { rsvpCountPending: Math.max(0, pending - 1) });

      return {
        email: typeof rsvp.email === "string" ? rsvp.email : "",
        name: typeof rsvp.name === "string" ? rsvp.name : "",
        event,
      };
    });

    if (result.email) {
      void sendRsvpEmail({
        variant: "denied",
        to: result.email,
        recipientName: result.name,
        rsvpId,
        event: {
          id: eventId,
          title: result.event.title,
          location: result.event.location,
          locationHidden: result.event.locationHidden,
          locationPublicText: result.event.locationPublicText,
          startAt: result.event.startAt?.toDate?.() ?? null,
          endAt: result.event.endAt?.toDate?.() ?? null,
          foodText: result.event.foodText,
          dietaryTags: result.event.dietaryTags,
          foodProvenance: result.event.foodProvenance,
          foodProvenanceNote: result.event.foodProvenanceNote,
          signupForm: result.event.signupForm,
        },
        decisionNote: note || null,
      });
    }

    return NextResponse.json({ ok: true, status: "denied" });
  } catch (err) {
    if (err instanceof DenyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[rsvp deny] transaction failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Deny failed" },
      { status: 500 },
    );
  }
}

class DenyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
