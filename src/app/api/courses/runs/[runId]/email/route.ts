import { NextResponse } from "next/server";
import ApplicationEmail from "@/emails/ApplicationEmail";
import { dispatchSends } from "@/lib/email/dispatch";
import { sendNotice } from "@/lib/email/notice";
import {
  DAY_MS,
  NOTICES_PER_DAY,
  reserveNoticeSlots,
} from "@/lib/email/noticeCaps";
import {
  COURSE_MEMBER_PLACEHOLDER,
  displayNameOf,
  dropSuppressed,
  gateRunStaff,
  ownAddressFor,
  parseStaffMessage,
  reserveSendSlot,
  resolveCohortAudience,
  sendCourseRunEmail,
  staffMessageBlocks,
  staffPreheader,
  type CohortRecipient,
} from "@/lib/email/courseFacilitatorEmails";
import { courseRunChannel } from "@/lib/firestore/courses";
import { signToken } from "@/lib/signedTokens";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { sendNoticePush } from "@/lib/push/noticeNotifications";

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
 *
 * ── TWO LANES IN ONE ROUTE: `asNotice` ──────────────────────────────────────
 * The body may carry `asNotice: true`, which the composer offers as a tick. It
 * changes the CLASS of the send, and only that:
 *
 *  - WITHOUT it (the default, and every send before this flag existed), this is
 *    the GRID class on the `courses` row. `resolveCohortAudience` drops anybody
 *    whose row is a stored `false` before a message is rendered, the mail
 *    carries the unsubscribe footer and the RFC 8058 headers, and it does not
 *    push. An announcement is opt-outable and stays so.
 *  - WITH it, this is the NOTICE class. The audience is the whole cohort
 *    whatever the `courses` row says, the send goes through `sendNotice` (so it
 *    carries the marker line and a `kind: "notice"` receipt with `surface:
 *    "course-run"`), there is no unsubscribe affordance because there is
 *    nothing to unsubscribe from, and every recipient with a device is pushed.
 *
 * What does NOT change: the gate (the same run staff), the enrolment
 * re-verification, the guest-row drop, the 200-recipient refusal and the
 * suppression list. A notice may bypass what somebody chose; never who they
 * are, nor whether their address bounces.
 *
 * A TEST SEND IS NEVER A NOTICE. `testOnly` reaches the sender's own address
 * and nobody else, so nobody's preference is bypassed and the marker's sentence
 * would be false about it; `testOnly` wins over `asNotice` and the rehearsal
 * goes out on the ordinary lane, marked `[TEST]`, as it always has.
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
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

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
  // Read off the raw body rather than through `parseStaffMessage`, which is
  // shared with the group route and has no notice lane to describe. Anything
  // that is not a literal `true` is the ordinary announcement: a class this
  // consequential is not something a truthy string should be able to choose.
  const asNotice =
    !testOnly &&
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).asNotice === true;

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
    // The one line the two lanes differ by. See "TWO LANES IN ONE ROUTE".
    const audience = asNotice
      ? await resolveCohortAudience(db, runId, LANE, { ignoreCategoryOptOut: true })
      : await resolveCohortAudience(db, runId, LANE);
    if (audience.refusal) {
      return NextResponse.json({ error: audience.refusal }, { status: 400 });
    }
    recipients = audience.members;
    skipped += audience.skipped;
  }

  if (recipients.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped });
  }

  // The hourly (sender, run) budget both lanes have always had, plus the notice
  // lane's per-run daily one on a real send, claimed in one transaction so a
  // refusal on either spends neither. A rehearsal keeps its own looser counter.
  let refusal: { message: string; retryAfterSeconds: number } | null = null;
  try {
    if (testOnly) {
      const slot = await reserveSendSlot(db, {
        key: `runtest__${runId}__${actor.uid}`,
        limit: TEST_SENDS_PER_WINDOW,
        windowMs: WINDOW_MS,
      });
      if (!slot.ok) {
        refusal = {
          message: "Too many test sends for this run in the last hour.",
          retryAfterSeconds: slot.retryAfterSeconds,
        };
      }
    } else {
      const slot = await reserveNoticeSlots(db, {
        hour: {
          key: `run__${runId}__${actor.uid}`,
          limit: SENDS_PER_WINDOW,
          windowMs: WINDOW_MS,
        },
        day: { key: `runday__${runId}`, limit: NOTICES_PER_DAY, windowMs: DAY_MS },
        noun: asNotice ? "notices" : "announcements",
      });
      if (!slot.ok) {
        refusal = {
          message: slot.refusal ?? "That send was refused.",
          retryAfterSeconds: slot.retryAfterSeconds,
        };
      }
    }
  } catch (err) {
    // Fail CLOSED — see the group route.
    console.error("[courses run email] throttle read failed", runId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (refusal) {
    return NextResponse.json(
      { error: refusal.message },
      { status: 429, headers: { "Retry-After": String(refusal.retryAfterSeconds) } },
    );
  }

  const noticeContext = run.courseTitle
    ? `${run.courseTitle}${run.label ? ` (${run.label})` : ""}`
    : (run.label ?? "");
  const noticeBlocks = asNotice ? staffMessageBlocks(body, senderName, noticeContext) : [];
  const noticePreheader = asNotice ? staffPreheader(body) : "";
  const runPath = `/learn/${encodeURIComponent(runId)}`;

  let sent = 0;
  // Bounded concurrency, not a sequential sleep — `dispatchSends` carries the
  // wall-clock arithmetic against App Hosting's 60s request timeout, which a
  // full-size cohort send would otherwise blow through with the rate-limit slot
  // already spent.
  await dispatchSends(recipients, async (recipient) => {
    if (asNotice) {
      try {
        // ONE address. One message. No unsubscribe token is minted at all: the
        // lane has nothing to unsubscribe from, and a link that pretended
        // otherwise would be the one dishonest thing it could carry.
        await sendNotice({
          to: recipient.address,
          subject,
          surface: "course-run",
          actorUid: actor.uid,
          referenceId: runId,
          render: (marker) =>
            ApplicationEmail({
              subject,
              blocks: noticeBlocks,
              preheader: noticePreheader,
              notice: marker,
            }),
        });
        sent += 1;
      } catch (err) {
        // Uid only: an address must not reach the logs.
        console.error("[courses run notice] send failed", runId, recipient.uid, err);
        skipped += 1;
      }
      return;
    }

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

  // Push is the notice lane's second channel and the ordinary announcement has
  // none: an opt-outable cohort mail that also buzzed every phone is how people
  // turn notifications off for good.
  let pushed = 0;
  if (asNotice) {
    for (const recipient of recipients) {
      await sendNoticePush(recipient.uid, {
        title: run.courseTitle || run.label || "Course update",
        body: subject,
        url: runPath,
      });
      pushed += 1;
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, pushed });
}
