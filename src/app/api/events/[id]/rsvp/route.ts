import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  EMAIL_MAX,
  NAME_MAX,
  sanitizeSignupForm,
  type FormQuestion,
} from "@/lib/firestore/events";
import { sendRsvpEmail } from "@/lib/events/sendRsvpEmail";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { formatEventWhen } from "@/lib/events/changeSummary";

type RsvpPayload = {
  name?: unknown;
  email?: unknown;
  answers?: unknown;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function rsvpDocId(eventId: string, email: string): string {
  const hash = createHash("sha256").update(email).digest("hex").slice(0, 16);
  return `${eventId}_${hash}`;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  let payload: RsvpPayload;
  try {
    payload = (await req.json()) as RsvpPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Fetch the viewer up front — signed-in RSVPs are locked to session identity,
  // both as a spoofing guard and so the client can't accidentally submit with a
  // different email than the one shown in the UI.
  const viewer = await getCurrentUser();

  const bodyName = typeof payload.name === "string" ? payload.name.trim() : "";
  const bodyEmail =
    typeof payload.email === "string" ? normalizeEmail(payload.email) : "";

  const name =
    viewer?.displayName?.trim() || viewer?.email?.trim() || bodyName;
  const email = viewer?.email ? normalizeEmail(viewer.email) : bodyEmail;

  if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });
  if (name.length > NAME_MAX) {
    return NextResponse.json({ error: `Name is too long (max ${NAME_MAX}).` }, { status: 400 });
  }
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });
  if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
  }

  const eventRef = db.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }
  const event = eventSnap.data() ?? {};

  // Drafters/approvers/admins may test-signup to non-published events. Everyone
  // else only sees published events (status check below).
  const isStaff =
    !!viewer &&
    (viewer.role === "admin" ||
      viewer.permissions.draftEvent ||
      viewer.permissions.approveEvent);

  if (event.status !== "published" && !isStaff) {
    return NextResponse.json({ error: "This event isn't open for signups." }, { status: 400 });
  }
  if (event.status === "cancelled") {
    return NextResponse.json({ error: "This event has been cancelled." }, { status: 400 });
  }

  const visibility = event.visibility === "public" ? "public" : "members";
  if (visibility === "members" && !viewer) {
    return NextResponse.json(
      { error: "This event is for signed-in members. Please sign in first." },
      { status: 401 },
    );
  }

  const questions: FormQuestion[] = sanitizeSignupForm(event.signupForm);
  const validated = validateAnswers(questions, payload.answers);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  // Snapshot the schedule/location the attendee is signing up against, so the
  // approve route can later flag anything the organiser changed in between.
  const signupSnapshot = {
    scheduleLabel: formatEventWhen(
      event.startAt?.toDate?.() ?? null,
      event.endAt?.toDate?.() ?? null,
    ),
    locationLabel: typeof event.location === "string" ? event.location : "",
  };

  const rsvpRef = db.collection("eventRsvps").doc(rsvpDocId(eventId, email));

  try {
    const result = await db.runTransaction(async (tx) => {
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap2 = await tx.get(eventRef);
      const evt = eventSnap2.data() ?? {};
      const pending: number = typeof evt.rsvpCountPending === "number" ? evt.rsvpCountPending : 0;

      if (rsvpSnap.exists) {
        const existing = rsvpSnap.data() ?? {};
        // Allow resubmit after a prior cancellation or denial. Otherwise, block
        // duplicate pending/confirmed/waitlisted submissions.
        if (
          existing.status === "pending" ||
          existing.status === "confirmed" ||
          existing.status === "waitlisted"
        ) {
          throw new RsvpError(
            `You've already RSVP'd to this event (${existing.status}). An organiser will follow up.`,
            409,
          );
        }
      }

      // All new RSVPs land in "pending" for organiser review. Capacity / waitlist
      // decisions happen at approval time, not at submit time.
      const rsvpData: Record<string, unknown> = {
        eventId,
        uid: viewer?.uid ?? null,
        name,
        email,
        answers: validated.answers,
        status: "pending",
        decisionNote: null,
        decidedBy: null,
        decidedAt: null,
        signupSnapshot,
        createdAt: FieldValue.serverTimestamp(),
        cancelledAt: null,
      };

      tx.set(rsvpRef, rsvpData);
      tx.update(eventRef, { rsvpCountPending: pending + 1 });

      return { status: "pending" as const, rsvpId: rsvpRef.id };
    });

    // Fire-and-forget confirmation email. Don't await inside the transaction —
    // if SMTP is slow or misconfigured, the user already has their RSVP saved.
    void sendRsvpEmail({
      variant: "requested",
      to: email,
      recipientName: name,
      rsvpId: result.rsvpId,
      answers: validated.answers,
      event: {
        id: eventId,
        title: event.title,
        location: event.location,
        locationHidden: event.locationHidden,
        locationPublicText: event.locationPublicText,
        startAt: event.startAt?.toDate?.() ?? null,
        endAt: event.endAt?.toDate?.() ?? null,
        foodText: event.foodText,
        dietaryTags: event.dietaryTags,
        foodProvenance: event.foodProvenance,
        foodProvenanceNote: event.foodProvenanceNote,
        signupForm: event.signupForm,
      },
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof RsvpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[rsvp] transaction failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Signup failed" },
      { status: 500 },
    );
  }
}

class RsvpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
