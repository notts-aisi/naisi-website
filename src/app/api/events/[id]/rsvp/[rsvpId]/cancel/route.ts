import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sendRsvpEmail } from "@/lib/events/sendRsvpEmail";
import { verifyRsvpToken } from "@/lib/events/rsvpToken";

/**
 * Cancel an RSVP. If the cancelled RSVP was "confirmed" and the event has a
 * waitlist, auto-promote the oldest "waitlisted" RSVP to "confirmed" in the
 * same transaction so the denormalized counters stay consistent.
 *
 * Gated to: the RSVP's own uid (for logged-in members), event approvers,
 * and admins. Public (anonymous) cancellation via signed tokens is deferred.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; rsvpId: string }> },
) {
  const { id: eventId, rsvpId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // Two paths in:
  //  1. Signed-in viewer (attendee or organiser). Uses session identity.
  //  2. Anonymous: a valid HMAC token from the RSVP email. Lets public
  //     email-only signups self-cancel without an account.
  const viewer = await getCurrentUser();
  const url = new URL(req.url);
  let tokenCandidate = url.searchParams.get("t") ?? "";
  if (!tokenCandidate) {
    try {
      const body = (await req.json().catch(() => null)) as { t?: unknown } | null;
      if (body && typeof body.t === "string") tokenCandidate = body.t;
    } catch {
      /* empty body is fine */
    }
  }

  const rsvpRef = db.collection("eventRsvps").doc(rsvpId);
  const eventRef = db.collection("events").doc(eventId);
  const waitlistQuery = db
    .collection("eventRsvps")
    .where("eventId", "==", eventId)
    .where("status", "==", "waitlisted")
    .orderBy("createdAt", "asc")
    .limit(1);

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap = await tx.get(eventRef);
      if (!rsvpSnap.exists) throw new CancelError("RSVP not found.", 404);
      if (!eventSnap.exists) throw new CancelError("Event not found.", 404);

      const rsvp = rsvpSnap.data() ?? {};
      const event = eventSnap.data() ?? {};

      if (rsvp.eventId !== eventId) {
        throw new CancelError("This RSVP doesn't belong to that event.", 400);
      }

      const rsvpEmail = typeof rsvp.email === "string" ? rsvp.email : "";
      const tokenValid =
        tokenCandidate !== "" &&
        rsvpEmail !== "" &&
        verifyRsvpToken(rsvpId, rsvpEmail, tokenCandidate);

      const isApprover =
        !!viewer &&
        (viewer.role === "admin" ||
          viewer.permissions.approveEvent ||
          (viewer.permissions.draftEvent && event.authorUid === viewer.uid));
      const isOwn =
        !!viewer && typeof rsvp.uid === "string" && rsvp.uid === viewer.uid;
      const isSelfService = tokenValid; // token holder == the RSVP'd person
      if (!isApprover && !isOwn && !isSelfService) {
        throw new CancelError("You can't cancel this RSVP.", 403);
      }

      const cancelledBySelf = isOwn || isSelfService;

      if (rsvp.status === "cancelled" || rsvp.status === "denied") {
        return {
          status: rsvp.status as "cancelled" | "denied",
          promoted: null,
          cancelledBySelf,
          cancelled: null,
          event,
        };
      }

      const wasPending = rsvp.status === "pending";
      const wasConfirmed = rsvp.status === "confirmed";
      const wasWaitlisted = rsvp.status === "waitlisted";

      let promoted:
        | { id: string; email: string; name: string; answers: Record<string, unknown> }
        | null = null;
      if (wasConfirmed && event.waitlistEnabled) {
        const waitSnap = await tx.get(waitlistQuery);
        if (!waitSnap.empty) {
          const next = waitSnap.docs[0];
          const nextData = next.data() ?? {};
          // Double-check the candidate is still waitlisted (transactional read).
          tx.update(next.ref, { status: "confirmed" });
          promoted = {
            id: next.id,
            email: typeof nextData.email === "string" ? nextData.email : "",
            name: typeof nextData.name === "string" ? nextData.name : "",
            answers: (nextData.answers ?? {}) as Record<string, unknown>,
          };
        }
      }

      tx.update(rsvpRef, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
      });

      const pending: number = typeof event.rsvpCountPending === "number" ? event.rsvpCountPending : 0;
      const confirmed: number = typeof event.rsvpCountConfirmed === "number" ? event.rsvpCountConfirmed : 0;
      const waitlisted: number = typeof event.rsvpCountWaitlisted === "number" ? event.rsvpCountWaitlisted : 0;

      let nextPending = pending;
      let nextConfirmed = confirmed;
      let nextWaitlisted = waitlisted;
      if (wasPending) {
        nextPending = Math.max(0, pending - 1);
      } else if (wasConfirmed) {
        nextConfirmed = Math.max(0, confirmed - 1);
        if (promoted) {
          // Promoted a waitlisted -> confirmed, so bump confirmed back up, drop waitlisted.
          nextConfirmed += 1;
          nextWaitlisted = Math.max(0, waitlisted - 1);
        }
      } else if (wasWaitlisted) {
        nextWaitlisted = Math.max(0, waitlisted - 1);
      }

      tx.update(eventRef, {
        rsvpCountPending: nextPending,
        rsvpCountConfirmed: nextConfirmed,
        rsvpCountWaitlisted: nextWaitlisted,
      });

      return {
        status: "cancelled" as const,
        promoted,
        cancelledBySelf,
        cancelled: {
          email: typeof rsvp.email === "string" ? rsvp.email : "",
          name: typeof rsvp.name === "string" ? rsvp.name : "",
          priorStatus: rsvp.status as "pending" | "confirmed" | "waitlisted",
          answers: (rsvp.answers ?? {}) as Record<string, unknown>,
        },
        event,
      };
    });

    // Email fan-out (fire-and-forget). Built outside the transaction so SMTP
    // latency can't fail the user's request or hold locks on Firestore rows.
    const eventShape = {
      id: eventId,
      title: outcome.event.title,
      location: outcome.event.location,
      locationHidden: outcome.event.locationHidden,
      locationPublicText: outcome.event.locationPublicText,
      startAt: outcome.event.startAt?.toDate?.() ?? null,
      endAt: outcome.event.endAt?.toDate?.() ?? null,
      foodText: outcome.event.foodText,
      dietaryTags: outcome.event.dietaryTags,
      foodProvenance: outcome.event.foodProvenance,
      foodProvenanceNote: outcome.event.foodProvenanceNote,
      signupForm: outcome.event.signupForm,
    };

    // Organiser cancelled someone else — notify the attendee. (Skip if the
    // attendee cancelled themselves; they initiated it.)
    if (
      !outcome.cancelledBySelf &&
      outcome.cancelled &&
      outcome.cancelled.email &&
      // Only inform if they were actually holding a spot — don't spam people
      // whose pending request was simply withdrawn by an organiser.
      (outcome.cancelled.priorStatus === "confirmed" ||
        outcome.cancelled.priorStatus === "waitlisted")
    ) {
      void sendRsvpEmail({
        variant: "cancelled",
        to: outcome.cancelled.email,
        recipientName: outcome.cancelled.name,
        rsvpId,
        event: eventShape,
      });
    }

    // Auto-promoted waitlister → tell them.
    if (outcome.promoted && outcome.promoted.email) {
      void sendRsvpEmail({
        variant: "promoted",
        to: outcome.promoted.email,
        recipientName: outcome.promoted.name,
        rsvpId: outcome.promoted.id,
        answers: outcome.promoted.answers as Record<string, import("@/lib/firestore/events").RsvpAnswer>,
        event: eventShape,
      });
    }

    return NextResponse.json({
      ok: true,
      status: outcome.status,
      promoted: outcome.promoted ? { id: outcome.promoted.id } : null,
    });
  } catch (err) {
    if (err instanceof CancelError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[rsvp cancel] transaction failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed" },
      { status: 500 },
    );
  }
}

class CancelError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
