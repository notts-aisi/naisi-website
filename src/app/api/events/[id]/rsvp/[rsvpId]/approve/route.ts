import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sendRsvpEmail } from "@/lib/events/sendRsvpEmail";

/**
 * Organiser action: approve a pending RSVP.
 *
 * Transitions:
 *   pending → confirmed (if capacity has room or capacity is unlimited)
 *   pending → waitlisted (if capacity hit and waitlist is enabled)
 *   pending → error (if capacity hit and no waitlist)
 *
 * Gated to: event author (draftEvent), approvers, admins.
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

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap = await tx.get(eventRef);
      if (!rsvpSnap.exists) throw new ApproveError("RSVP not found.", 404);
      if (!eventSnap.exists) throw new ApproveError("Event not found.", 404);

      const rsvp = rsvpSnap.data() ?? {};
      const event = eventSnap.data() ?? {};

      if (rsvp.eventId !== eventId) {
        throw new ApproveError("This RSVP doesn't belong to that event.", 400);
      }

      const isApprover =
        viewer.role === "admin" ||
        viewer.permissions.approveEvent ||
        (viewer.permissions.draftEvent && event.authorUid === viewer.uid);
      if (!isApprover) throw new ApproveError("You can't approve this RSVP.", 403);

      if (rsvp.status !== "pending") {
        throw new ApproveError(`Only pending RSVPs can be approved (was "${rsvp.status}").`, 400);
      }

      const capacity =
        typeof event.capacity === "number" && event.capacity > 0
          ? Math.floor(event.capacity)
          : null;
      const waitlistEnabled = capacity !== null && event.waitlistEnabled !== false;

      const pending = typeof event.rsvpCountPending === "number" ? event.rsvpCountPending : 0;
      const confirmed = typeof event.rsvpCountConfirmed === "number" ? event.rsvpCountConfirmed : 0;
      const waitlisted = typeof event.rsvpCountWaitlisted === "number" ? event.rsvpCountWaitlisted : 0;

      let newStatus: "confirmed" | "waitlisted";
      if (capacity === null || confirmed < capacity) {
        newStatus = "confirmed";
      } else if (waitlistEnabled) {
        newStatus = "waitlisted";
      } else {
        throw new ApproveError(
          "Event is full and no waitlist is enabled. Increase capacity or enable the waitlist first.",
          409,
        );
      }

      tx.update(rsvpRef, {
        status: newStatus,
        decidedBy: viewer.uid,
        decidedAt: FieldValue.serverTimestamp(),
        decisionNote: null,
      });
      tx.update(eventRef, {
        rsvpCountPending: Math.max(0, pending - 1),
        rsvpCountConfirmed: newStatus === "confirmed" ? confirmed + 1 : confirmed,
        rsvpCountWaitlisted: newStatus === "waitlisted" ? waitlisted + 1 : waitlisted,
      });

      return {
        status: newStatus,
        email: typeof rsvp.email === "string" ? rsvp.email : "",
        name: typeof rsvp.name === "string" ? rsvp.name : "",
        answers: (rsvp.answers ?? {}) as Record<string, unknown>,
        event,
      };
    });

    const { event: evt } = outcome;
    if (outcome.email) {
      void sendRsvpEmail({
        variant: outcome.status === "confirmed" ? "approved" : "waitlisted",
        to: outcome.email,
        recipientName: outcome.name,
        rsvpId,
        answers: outcome.answers as Record<string, import("@/lib/firestore/events").RsvpAnswer>,
        event: {
          id: eventId,
          title: evt.title,
          location: evt.location,
          locationHidden: evt.locationHidden,
          locationPublicText: evt.locationPublicText,
          startAt: evt.startAt?.toDate?.() ?? null,
          endAt: evt.endAt?.toDate?.() ?? null,
          foodProvenance: evt.foodProvenance,
          foodProvenanceNote: evt.foodProvenanceNote,
          signupForm: evt.signupForm,
        },
      });
    }

    return NextResponse.json({ ok: true, status: outcome.status });
  } catch (err) {
    if (err instanceof ApproveError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[rsvp approve] transaction failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approve failed" },
      { status: 500 },
    );
  }
}

class ApproveError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
