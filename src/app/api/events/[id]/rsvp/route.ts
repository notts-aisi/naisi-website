import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { canApproveEvent, canDraftEvent } from "@/lib/firestore/users";
import {
  EMAIL_MAX,
  NAME_MAX,
  sanitizeSignupForm,
  type FormQuestion,
} from "@/lib/firestore/events";
import { sendRsvpEmail, type LiveRsvpStatus } from "@/lib/events/sendRsvpEmail";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { formatEventWhen } from "@/lib/events/changeSummary";
import { verifyRecaptcha } from "@/lib/recaptcha/server";
import { recaptchaBypassGranted } from "@/lib/recaptcha/bypass";
import { clientIp, rateLimit } from "@/lib/rateLimit";

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
 * Not closed, and said so rather than pretended: the three outcomes commit a
 * different number of writes (none for a repeat inside the hour, one for a
 * repeat that earns the note, two for a fresh row), so the response times
 * differ structurally. The register route documents the same timing channel
 * for the same reason.
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
 *
 * ── THE BOT GATE, AND WHY THIS ROUTE NEEDED ONE ─────────────────────────────
 * Every accepted submission writes a row and posts a NAISI-branded email, from
 * the society's own sending domain, to an address the CALLER chose, carrying a
 * greeting name and free-text answers the caller also chose. Until 9 September
 * 2026 nothing gated that: no session on a public event, no reCAPTCHA, no
 * throttle. A list of harvested addresses and a loop was a spam run with real
 * DKIM on it, and the bounces and complaints landed on the society's own
 * sender reputation and suppression list. Plus-addressing multiplied the
 * per-address quota, and each further public event multiplied it again,
 * because the duplicate guard is per event.
 *
 * So the same two gates `/api/register` carries, in the same order and for the
 * same reasons. The per-IP throttle runs FIRST, before the session lookup and
 * before any document is read, because the point of throttling is to cap cost
 * and a limiter behind the reads it protects has already paid for the request
 * it is about to refuse. reCAPTCHA is the primary gate and the throttle is the
 * cheap backstop; the per-IP allowance is deliberately looser than the
 * register route's, because a stall at a fair or a shout-out in a lecture
 * produces a real burst of sign-ups from one campus NAT address, while
 * `/api/register` is a thing people do once.
 *
 * `verifyRecaptcha` FAILS CLOSED in production when `RECAPTCHA_SECRET` is
 * absent, which is why that secret has to be on every backend running in
 * production mode. `scripts/e2e/tests/public-write-gating.test.mjs` is the
 * battery that asks a deployed backend whether the gate is really live here.
 */

type RsvpPayload = {
  name?: unknown;
  email?: unknown;
  answers?: unknown;
  recaptchaToken?: unknown;
};

/**
 * The abuse throttle. Ten-minute fixed windows, in memory, alongside
 * reCAPTCHA rather than instead of it (see `src/lib/rateLimit.ts`).
 *
 * The per-IP allowance is sixty rather than the register route's thirty, and
 * the difference is the shape of the two acts: registering is something a
 * person does once, while sixty RSVPs from one campus NAT address inside ten
 * minutes is a stall at a fair having a good afternoon. The per-address
 * allowance is five, which is generous for somebody correcting a typo and
 * useless as a way to fill an inbox.
 */
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_IP_MAX = 60;
const RL_EMAIL_MAX = 5;

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

/**
 * ONE 429, whichever axis fired. Two different sentences would say which
 * bucket was full, and one of those buckets is keyed on an address the caller
 * typed, so the difference would be a question about that address.
 */
function tooManySignups(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many sign-ups just now. Please wait a few minutes and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await ctx.params;

  // BEFORE THE SESSION LOOKUP AND BEFORE ANY DOCUMENT IS READ. See the header:
  // a limiter that runs after the reads it protects has already paid for the
  // request it refuses. A 429 here is volume-based and says nothing about the
  // event or the address, so it leaks nothing either.
  const ip = clientIp(req);
  const ipLimit = rateLimit(`events:rsvp:ip:${ip}`, RL_IP_MAX, RL_WINDOW_MS);
  if (!ipLimit.ok) return tooManySignups(ipLimit.retryAfterSeconds);

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

  // THE BOT GATE. The harness bypass is consulted ONLY for a request that
  // carries no token, and only for an address inside the harness namespace on
  // a backend that holds the secret (src/lib/recaptcha/bypass.ts); a token
  // that is present is always verified with Google. The acting identity is the
  // address the confirmation would go to, which is the session's for a
  // signed-in caller and the typed one otherwise.
  const recaptchaToken =
    typeof payload.recaptchaToken === "string" && payload.recaptchaToken.length > 0
      ? payload.recaptchaToken
      : undefined;
  const bypassed =
    recaptchaToken === undefined && recaptchaBypassGranted(req.headers, email);
  if (!bypassed && !(await verifyRecaptcha(recaptchaToken))) {
    return NextResponse.json(
      { error: "Couldn't verify you're human. Please reload the page and try again." },
      { status: 400 },
    );
  }

  // THE PER-ADDRESS AXIS, AND IT COMES AFTER THE BOT GATE ON PURPOSE. It is
  // the tighter of the two, so it is also the one that can be turned around:
  // an address is something anybody can type, and a bucket consumed before the
  // caller has proved anything is a way to lock a named person out of every
  // event for ten minutes with five requests that cost nothing. Behind the
  // captcha it still bounds a real person's own submissions, and the price of
  // aiming it at somebody else is a solved challenge per attempt. The per-IP
  // cap above is the one that has to run first, because its job is to cap the
  // cost of the request itself.
  const emailLimit = rateLimit(`events:rsvp:email:${email}`, RL_EMAIL_MAX, RL_WINDOW_MS);
  if (!emailLimit.ok) return tooManySignups(emailLimit.retryAfterSeconds);

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
    (canDraftEvent(viewer) || canApproveEvent(viewer));

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
    // The detail goes to the log, not to the caller. This route promises a
    // signed-out person learns nothing from it, and a raw `Error.message` off
    // a Firestore failure carries collection paths and index hints.
    console.error("[rsvp] transaction failed", err);
    return NextResponse.json({ error: "Signup failed" }, { status: 500 });
  }
}

class RsvpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
