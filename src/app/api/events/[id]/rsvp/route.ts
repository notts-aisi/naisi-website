import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  EMAIL_MAX,
  NAME_MAX,
  sanitizeSignupForm,
  type FormQuestion,
} from "@/lib/firestore/events";
import { sendRsvpEmail, type LiveRsvpStatus } from "@/lib/events/sendRsvpEmail";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { formatEventWhen } from "@/lib/events/changeSummary";

/**
 * PUBLIC RSVP SUBMISSION, and the only route a signed-out person can write an
 * `eventRsvps` row through.
 *
 * ── IDENTITY, AND WHO IT IS CHECKED AGAINST ─────────────────────────────────
 * A signed-in caller is the session: name and address come off it, whatever
 * the body says, and their RSVP is unique per ACCOUNT on the event. A
 * signed-out caller is an address they typed, unverified, and their RSVP is
 * unique per ADDRESS on the event. Those are two different keys on purpose. A
 * row filed by a stranger who typed a member's address must never occupy the
 * member's place: the member's own submission is matched by uid, so the
 * stranger's row sits beside it as one more pending request for the organiser
 * to see through, which is what it is.
 *
 * Until 8 September 2026 the document id was `<eventId>_<sha256(email)>`,
 * one slot per address whoever filled it, and the duplicate refusal quoted the
 * existing row's status. Together those made the route an attendee oracle for
 * anyone on the internet, one address per request, over data `firestore.rules`
 * restricts to SU-recognised committee, and let a guest submission pre-empt a
 * member's. Ids are Firestore's own now, and the address lookup below is a
 * query inside the transaction.
 *
 * ── A SIGNED-OUT CALLER LEARNS NOTHING ──────────────────────────────────────
 * A signed-out submission answers `{ ok: true, status: "pending" }` whether a
 * row was created or one already existed. The truth goes to the INBOX, which
 * only the address owner reads: a duplicate earns a note saying an RSVP is
 * already on file, and what state it is in, once an hour at most. A signed-in
 * caller asking about their own account still gets the 409, because that is
 * their own row. `tests/event-rsvp-identity.test.mjs` executes both.
 *
 * ── AN APPROVED ACCOUNT FOR A MEMBERS-ONLY EVENT ────────────────────────────
 * `getCurrentUser` hands back a session for every role, `pending` and
 * `rejected` included, so "signed in" was never "a member". A members-only
 * event admits `member`, `committee` and `admin`, the same three the
 * broadcast route treats as approved.
 *
 * ── AFTER A CANCELLATION OR A DENIAL ────────────────────────────────────────
 * A person may submit again, and that is a NEW row: the old one keeps its
 * status, the organiser's note and who decided it, rather than being reset
 * underneath them by whoever next typed the address.
 */

type RsvpPayload = {
  name?: unknown;
  email?: unknown;
  answers?: unknown;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The statuses that mean an RSVP is on file. Cancelled and denied are not. */
const LIVE_STATUSES: readonly LiveRsvpStatus[] = ["pending", "confirmed", "waitlisted"];

/** How often the duplicate note may be mailed to one address for one row. */
const DUPLICATE_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/** What every signed-out submission is told, created or not. */
const ACCEPTED = { ok: true as const, status: "pending" as const };

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isLive(status: unknown): status is LiveRsvpStatus {
  return LIVE_STATUSES.includes(status as LiveRsvpStatus);
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
  const approvedAccount =
    !!viewer &&
    (viewer.role === "member" || viewer.role === "committee" || viewer.role === "admin");

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
  if (visibility === "members") {
    if (!viewer) {
      return NextResponse.json(
        { error: "This event is for signed-in members. Please sign in first." },
        { status: 401 },
      );
    }
    if (!approvedAccount) {
      return NextResponse.json(
        { error: "This event is for approved NAISI members." },
        { status: 403 },
      );
    }
  }

  const questions: FormQuestion[] = sanitizeSignupForm(event.signupForm);
  const validated = validateAnswers(questions, payload.answers);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  // Snapshot the schedule/location the attendee is signing up against, so the
  // approve route can later flag anything the organiser changed in between.
  // The row is readable by SU-recognised committee and admins only, and the
  // approve route shows the diff to a CONFIRMED attendee alone.
  const signupSnapshot = {
    scheduleLabel: formatEventWhen(
      event.startAt?.toDate?.() ?? null,
      event.endAt?.toDate?.() ?? null,
    ),
    locationLabel: typeof event.location === "string" ? event.location : "",
  };

  const rsvps = db.collection("eventRsvps");
  // The identity the duplicate check keys on: the account when there is one,
  // the address otherwise. See the header.
  const ownRows = viewer
    ? rsvps.where("eventId", "==", eventId).where("uid", "==", viewer.uid)
    : rsvps.where("eventId", "==", eventId).where("email", "==", email);

  type Outcome =
    | { kind: "created"; rsvpId: string }
    | { kind: "existing"; rsvpId: string; status: LiveRsvpStatus; notify: boolean };

  try {
    const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
      const ownSnap = await tx.get(ownRows);
      const eventSnap2 = await tx.get(eventRef);
      const evt = eventSnap2.data() ?? {};
      const pending: number = typeof evt.rsvpCountPending === "number" ? evt.rsvpCountPending : 0;

      const live = ownSnap.docs.find((doc) => isLive((doc.data() ?? {}).status));
      if (live) {
        const existing = live.data() ?? {};
        const status = existing.status as LiveRsvpStatus;
        if (viewer) {
          // Their own row: the answer may say so.
          throw new RsvpError(
            `You've already RSVP'd to this event (${status}). An organiser will follow up.`,
            409,
          );
        }
        // Signed out: the caller is told nothing, the address is told once an
        // hour. The stamp is on the row so the throttle survives a restart.
        const lastNotice: number =
          typeof existing.duplicateNoticeAt?.toMillis === "function"
            ? existing.duplicateNoticeAt.toMillis()
            : 0;
        const notify = Date.now() - lastNotice >= DUPLICATE_NOTICE_INTERVAL_MS;
        if (notify) tx.update(live.ref, { duplicateNoticeAt: FieldValue.serverTimestamp() });
        return { kind: "existing", rsvpId: live.id, status, notify };
      }

      // All new RSVPs land in "pending" for organiser review. Capacity / waitlist
      // decisions happen at approval time, not at submit time.
      const rsvpRef = rsvps.doc();
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

      return { kind: "created", rsvpId: rsvpRef.id };
    });

    const eventShape = {
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
    };

    if (outcome.kind === "existing") {
      if (outcome.notify) {
        void sendRsvpEmail({
          variant: "existing",
          to: email,
          recipientName: name,
          rsvpId: outcome.rsvpId,
          existingStatus: outcome.status,
          event: eventShape,
        });
      }
      return NextResponse.json(ACCEPTED);
    }

    // Fire-and-forget confirmation email. Don't await inside the transaction —
    // if SMTP is slow or misconfigured, the user already has their RSVP saved.
    void sendRsvpEmail({
      variant: "requested",
      to: email,
      recipientName: name,
      rsvpId: outcome.rsvpId,
      answers: validated.answers,
      event: eventShape,
    });

    return NextResponse.json(ACCEPTED);
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
