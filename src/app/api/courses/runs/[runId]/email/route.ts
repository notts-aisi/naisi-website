import { NextResponse } from "next/server";
import {
  COURSE_MEMBER_PLACEHOLDER,
  dispatchSends,
  displayNameOf,
  dropSuppressed,
  gateRunStaff,
  ownAddressFor,
  parseStaffMessage,
  reserveSendSlot,
  resolveCohortAudience,
  sendCourseRunEmail,
  type CohortRecipient,
} from "@/lib/email/courseFacilitatorEmails";
import { courseRunChannel } from "@/lib/firestore/courses";
import { signToken } from "@/lib/signedTokens";

/**
 * EMAIL THE COHORT — the announcement lane. One message to everyone on a run:
 * "applications for term two open Monday", "the week 4 reading has changed".
 * The group email route is its operational twin; the two differ in who may
 * send, who receives, and — the part that matters legally — whether the
 * recipient can opt out.
 *
 * ── ONE MESSAGE PER RECIPIENT. NOT NEGOTIABLE. ──────────────────────────────
 * The dispatch at the bottom sends ONE `sendEmail` per address with a single
 * string `to`. Never an array, never a Cc. A cohort is up to 200 people; one
 * batched envelope would hand all 200 addresses to all 200 people. Sends run
 * through `dispatchSends`, which bounds how many are in flight and carries the
 * arithmetic that keeps a full-size send inside App Hosting's 60s request
 * timeout — a broadcast that outlives the request has already spent its
 * rate-limit slot and can only be retried by re-mailing everyone.
 *
 * ── WHO MAY SEND, AND WHO RECEIVES: BOTH LIVE IN THE SHARED MODULE ──────────
 * `gateRunStaff` and `resolveCohortAudience` in
 * `src/lib/email/courseFacilitatorEmails.ts` own the run-staff predicate and the
 * subscription ∩ active-enrolment audience, including the guest-row drop, the
 * `courses` category opt-out, suppression, and the recipient cap that REFUSES
 * rather than truncates. Both carry the full argument in their own headers.
 *
 * They are shared with P11's weekly nudge because a nudge IS an announcement to
 * the whole run: the two lanes must agree on who may speak for a cohort and who
 * is in it, and they used to agree by being written out twice.
 *
 * ── THE 200 CAP FAILS THE REQUEST ───────────────────────────────────────────
 * `MAX_COHORT_RECIPIENTS` refuses rather than truncates. A partial cohort send
 * is the worst outcome available: it looks successful, and nobody can tell which
 * 200 of the 260 got the mail — least of all on a second attempt, which would
 * re-mail the same first 200. A run that outgrows the cap needs a chunked sender
 * with per-recipient bookkeeping, which is a different feature.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const WINDOW_MS = 60 * 60 * 1000;
/**
 * Real sends per (sender, run) per hour. Not required by the P9 brief the way
 * the group cap is, but a duplicate broadcast is this route's characteristic
 * mistake — a double-clicked Send is 400 emails — and the same durable counter
 * was already here to use.
 */
const SENDS_PER_WINDOW = 3;
/** Test sends per (sender, run) per hour, on their own counter. */
const TEST_SENDS_PER_WINDOW = 10;

/** Same lifetime the newsletter gives its unsubscribe links. */
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

/**
 * The two strings that make a shared audience derivation speak in this route's
 * voice — the log tag an operator greps for, and the advice that completes the
 * over-cap refusal. See `CohortAudienceLane`.
 */
const LANE = {
  logTag: "courses run email",
  overCapAdvice: "split the announcement",
} as const;

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  // AUTHORIZATION BEFORE EXISTENCE, and before the body is parsed.
  const gate = await gateRunStaff(runId);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  const { actor, db, run } = gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
  }
  const parsed = parseStaffMessage(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { subject, body, testOnly } = parsed.value;

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const channel = courseRunChannel(runId);

  const actorSnap = await db.collection("users").doc(actor.uid).get();
  const actorData = actorSnap.data() ?? {};
  // The placeholder is the right fallback on THIS lane: `NewsletterEmail`
  // renders a greeting of its own and needs a name to put in it.
  const senderName = actorSnap.exists
    ? displayNameOf(actorData)
    : actor.displayName?.trim() || COURSE_MEMBER_PLACEHOLDER;

  let skipped = 0;
  let recipients: CohortRecipient[] = [];

  if (testOnly) {
    const own = ownAddressFor(actorData, actor.email, gmailOnly);
    if (!own) {
      return NextResponse.json(
        { error: "Your account has no email address on file to send a test to." },
        { status: 400 },
      );
    }
    // A rehearsal is filtered too: a sender whose own address has bounced has to
    // learn that from the test rather than from a silent cohort send.
    const { deliverable, dropped } = await dropSuppressed(db, [
      {
        uid: actor.uid,
        address: own,
        recipientName: senderName,
        ownName: senderName,
        groupId: null,
      },
    ]);
    recipients = deliverable;
    skipped += dropped;
  } else {
    const audience = await resolveCohortAudience(db, runId, LANE);
    if (audience.refusal) {
      return NextResponse.json({ error: audience.refusal }, { status: 400 });
    }
    recipients = audience.members;
    skipped += audience.skipped;
  }

  if (recipients.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped });
  }

  let slot;
  try {
    slot = await reserveSendSlot(db, {
      key: `run${testOnly ? "test" : ""}__${runId}__${actor.uid}`,
      limit: testOnly ? TEST_SENDS_PER_WINDOW : SENDS_PER_WINDOW,
      windowMs: WINDOW_MS,
    });
  } catch (err) {
    // Fail CLOSED — see the group route.
    console.error("[courses run email] throttle read failed", runId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      {
        error: testOnly
          ? "Too many test sends for this run in the last hour."
          : `You can send ${SENDS_PER_WINDOW} announcements an hour to this cohort. Try again shortly.`,
      },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  let sent = 0;
  // Bounded concurrency, not a sequential sleep — `dispatchSends` carries the
  // wall-clock arithmetic against App Hosting's 60s request timeout, which a
  // full-size cohort send would otherwise blow through with the rate-limit slot
  // already spent.
  await dispatchSends(recipients, async (recipient) => {
    // One token per recipient, scoped to THIS run's channel: clicking it drops
    // the cohort and nothing else. The token addresses the UID, so the
    // unsubscribe route flips the rows for both of that member's addresses.
    const token = signToken(
      { s: "unsubscribe", uid: recipient.uid, c: channel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(token)}`;

    try {
      // ONE address. One message. See the module comment.
      await sendCourseRunEmail({
        to: recipient.address,
        subject,
        body,
        senderName,
        actorUid: actor.uid,
        test: testOnly,
        runId,
        recipientName: recipient.recipientName,
        courseTitle: run.courseTitle || null,
        runLabel: run.label || null,
        unsubscribeUrl,
      });
      sent += 1;
    } catch (err) {
      // Uid only — an address must not reach the logs.
      console.error("[courses run email] send failed", runId, recipient.uid, err);
      skipped += 1;
    }
  });

  return NextResponse.json({ ok: true, sent, skipped });
}
