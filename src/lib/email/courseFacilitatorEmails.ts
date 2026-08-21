import "server-only";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import ApplicationEmail from "@/emails/ApplicationEmail";
import NewsletterEmail from "@/emails/NewsletterEmail";
import { newBlockId, type Block } from "@/lib/firestore/newsletterBlocks";
import { sendEmail } from "./send";

/**
 * The send-side machinery for STAFF-AUTHORED course mail — the two P9 email
 * routes (`/api/courses/groups/[groupId]/email`,
 * `/api/courses/runs/[runId]/email`) and nothing else. Templates, payload
 * validation, and the durable send throttle live together because both routes
 * must agree on all three; route handlers don't import from one another by
 * house convention, so this module is where they meet.
 *
 * Sits beside `courseApplicationEmails.ts` and takes the same shape (a thin,
 * typed wrapper over `sendEmail` that renders through the shared chrome), with
 * one decisive difference: application mail renders ADMIN-AUTHORED BLOCKS from
 * `courseEmailTemplates`, whereas everything here renders a facilitator's
 * free-typed plain text arriving in a REQUEST BODY.
 *
 * ── THE BODY IS TEXT. IT IS NEVER HTML. ─────────────────────────────────────
 * `BlockRenderer` renders a `richText` block with `dangerouslySetInnerHTML`,
 * because newsletter blocks are TipTap output from a permissioned drafter that
 * an admin approves before it sends. A course email has neither property: any
 * facilitator can type into it and it goes out unreviewed. So `bodyToBlocks`
 * ESCAPES the text and builds the markup itself — the only HTML that reaches a
 * richText block from here is the `<p>`/`<br />` skeleton this file writes.
 * Nothing in a request body is ever concatenated into markup unescaped. If you
 * add a field to these templates, escape it the same way or render it through a
 * React child (which escapes by construction).
 *
 * ── FROM-NAME IS DELIBERATELY NOT OVERRIDDEN ────────────────────────────────
 * `sendEmail` falls back to `SMTP_FROM_NAME`, which the dev backend overrides
 * to "NAISI (dev)". Dev sends REAL mail through the same sender as production,
 * and that env override is the only thing distinguishing a dev send in the
 * recipient's inbox. Passing a pretty `fromName` here (e.g. "NAISI Courses",
 * as the events routes do) would erase the tag on the highest-volume,
 * least-reviewed mail in the estate. Don't.
 *
 * ── REPLY-TO IS THE ORG INBOX, NOT THE SENDER ───────────────────────────────
 * No `replyTo` is passed, so `EMAIL_DEFAULT_REPLY_TO` applies. Setting it to
 * the facilitator's address would hand every member of the group their
 * facilitator's personal email — the exact disclosure the PII-free roster
 * exists to prevent. The sender is named (names only) in the signature line.
 */

// ---------------------------------------------------------------------------
// Payload limits + validation (shared by both routes)
// ---------------------------------------------------------------------------

export const COURSE_STAFF_EMAIL_LIMITS = {
  /** One inbox-friendly line. Also the composer's counter budget. */
  subject: 150,
  /** ~700 words. A facilitator note, not a newsletter. */
  body: 4000,
} as const;

export type StaffMessage = {
  subject: string;
  /** Plain text, `\n`-normalised, trimmed. NEVER markup. */
  body: string;
  testOnly: boolean;
};

export type ParsedStaffMessage =
  | { ok: true; value: StaffMessage }
  | { ok: false; error: string };

/**
 * Validate a `{ subject, body, testOnly? }` request body. Both routes call
 * this so the caps, the messages, and the newline rules are identical on
 * either surface.
 *
 * The subject is rejected outright if it contains a CR or LF. Nodemailer
 * encodes header values, so this is belt-and-braces rather than the only
 * defence — but a header that cannot contain a line break cannot be split,
 * and the cost of the guarantee is one regex.
 */
export function parseStaffMessage(raw: unknown): ParsedStaffMessage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Expected a JSON object body." };
  }
  const b = raw as Record<string, unknown>;

  if (b.testOnly !== undefined && typeof b.testOnly !== "boolean") {
    return { ok: false, error: "testOnly must be true or false." };
  }
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (!subject) return { ok: false, error: "A subject is required." };
  if (/[\r\n]/.test(subject)) {
    return { ok: false, error: "The subject must be a single line." };
  }
  if (subject.length > COURSE_STAFF_EMAIL_LIMITS.subject) {
    return {
      ok: false,
      error: `The subject must be ${COURSE_STAFF_EMAIL_LIMITS.subject} characters or fewer.`,
    };
  }

  const body =
    typeof b.body === "string" ? b.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, error: "A message is required." };
  if (body.length > COURSE_STAFF_EMAIL_LIMITS.body) {
    return {
      ok: false,
      error: `The message must be ${COURSE_STAFF_EMAIL_LIMITS.body} characters or fewer.`,
    };
  }

  return { ok: true, value: { subject, body, testOnly: b.testOnly === true } };
}

// ---------------------------------------------------------------------------
// Durable send throttle
// ---------------------------------------------------------------------------

/**
 * `lib/rateLimit.ts` is in-memory ON PURPOSE (it throttles anonymous public
 * routes where a Firestore round trip per request would defeat the cost cap it
 * exists to enforce) and it says so: under scale-out each Cloud Run instance
 * holds its own counters, and a cold start forgets them. That is the right
 * trade for /api/register. It is the WRONG trade here: the thing being capped
 * is real mail to real members, the caller is already authenticated staff, and
 * "3 an hour" has to mean three in total, not three per instance per warm
 * period. So this counter is a Firestore transaction.
 *
 * Stored in `courseNudges`, which firestore.rules already locks `read, write:
 * if false` as server-side course-email bookkeeping — so this ships with NO
 * rules change, and rules deploy out of band (a rules edit landing ahead of or
 * behind its code has broken prod here before). Doc ids are prefixed
 * `emailrate__` to stay clear of P11's nudge markers in the same collection.
 */
const THROTTLE_COLLECTION = "courseNudges";

export type SendSlot = { ok: boolean; retryAfterSeconds: number };

function windowStartMs(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return 0;
}

/**
 * Claim one send against a fixed one-hour window, atomically.
 *
 * RESERVE-BEFORE-SEND, deliberately: the slot is consumed when the send is
 * attempted, not when it succeeds. A request that dies half way through a
 * 40-person group has already delivered part of the mail, and the retry has to
 * be rationed like any other send. Fail-closed is the only safe direction for
 * a throttle on outbound mail.
 */
export async function reserveSendSlot(
  db: Firestore,
  args: { key: string; limit: number; windowMs: number },
): Promise<SendSlot> {
  const ref = db.collection(THROTTLE_COLLECTION).doc(`emailrate__${args.key}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.data() ?? {};
    const startedAt = windowStartMs(data.windowStartAt);
    const count = typeof data.count === "number" ? data.count : 0;
    const inWindow = startedAt > 0 && now - startedAt < args.windowMs;

    if (inWindow && count >= args.limit) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((startedAt + args.windowMs - now) / 1000),
        ),
      };
    }

    tx.set(ref, {
      kind: "staff-email-throttle",
      key: args.key,
      windowStartAt: Timestamp.fromMillis(inWindow ? startedAt : now),
      count: inWindow ? count + 1 : 1,
      updatedAt: Timestamp.fromMillis(now),
    });
    return { ok: true, retryAfterSeconds: 0 };
  });
}

// ---------------------------------------------------------------------------
// Dispatch pacing
// ---------------------------------------------------------------------------

/**
 * FITTING A FULL-SIZE SEND INSIDE THE REQUEST TIMEOUT.
 *
 * `apphosting.yaml` sets `runConfig.timeoutSeconds: 60`. That number — not
 * politeness to the relay — is the binding constraint on how a broadcast is
 * dispatched, because `reserveSendSlot` above is RESERVE-BEFORE-SEND. A loop
 * killed at the ceiling is the worst outcome in this feature: the response never
 * lands, the slot is already spent, part of the cohort has the mail, and the
 * sender's only recourse is a retry that re-mails everyone already delivered.
 *
 * THE ARITHMETIC. The newsletter route paces sequentially with a 200ms sleep —
 * at most ONE message in flight. Each send here is a fresh Resend SMTP
 * connection (nodemailer is not pooled), a react-email render and a send-log
 * write: ~0.5s typical, ~1.0s on a bad day. Sequentially that is 0.7-1.2s per
 * recipient, so the run route's own 200-recipient ceiling costs 140-240s — two
 * to four times the timeout, i.e. a full cohort send could not complete at all.
 *
 * So the POSTURE is kept and the MECHANISM is replaced. The point of the 200ms
 * sleep is a bound on how much is in flight at once; a semaphore states that
 * bound explicitly instead of pinning it at one. With `SEND_CONCURRENCY` workers
 * each pausing `PER_SEND_DELAY_MS` after its own send:
 *
 *   run route, full 200:  ceil(200/6) = 34 rounds × 1.05s worst ≈ 36s  (≈19s typical)
 *   group route, full 100: ceil(100/6) = 17 rounds × 1.05s worst ≈ 18s  (≈9s typical)
 *
 * — so a full-size send finishes with ~24s of headroom against the 60s ceiling
 * even pessimistically. RAISING EITHER RECIPIENT CAP MEANS REDOING THIS SUM. A
 * cohort that needs more than one request needs the chunked sender with
 * per-recipient bookkeeping the run route's header already describes; that is a
 * different feature, and this arithmetic is what says when it is due.
 */
export const SEND_CONCURRENCY = 6;
export const PER_SEND_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `send` over `items` with at most `SEND_CONCURRENCY` in flight, pausing
 * `PER_SEND_DELAY_MS` between one worker's consecutive sends. Dispatch order is
 * not guaranteed and does not matter: every recipient gets their own message,
 * addressed only to them.
 *
 * `send` MUST RESOLVE. Both callers catch their own per-recipient failures
 * inside it (a send that throws is counted as skipped, never fatal), so a
 * rejection arriving here is a bug — and is deliberately left to reject the
 * request loudly rather than be swallowed into a partial send that reports
 * success.
 */
export async function dispatchSends<T>(
  items: readonly T[],
  send: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Math.min(SEND_CONCURRENCY, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await send(items[index]);
        await sleep(PER_SEND_DELAY_MS);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The whole reason a request body may touch a `richText` block. See the header. */
function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Plain text → ONE escaped richText block. Blank lines start a new paragraph;
 * single newlines become `<br />`. Escaping happens before either substitution,
 * so a body containing `<script>` or `</p>` ends up as literal characters in
 * the paragraph, never as markup.
 */
function bodyToBlocks(body: string): Block[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];
  const html = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
  return [{ id: newBlockId(), type: "richText", html }];
}

/**
 * The provenance line every staff email carries: who sent it and which cohort
 * surface it came from. NAMES ONLY — the same line the roster and review queue
 * hold. Escaped like the body; none of these values are trusted markup.
 */
function signatureBlock(senderName: string, context: string): Block {
  const line = context ? `${senderName} · ${context}` : senderName;
  return {
    id: newBlockId(),
    type: "richText",
    html: `<p style="margin:0;font-size:13px;color:#71717a">Sent by ${escapeHtml(line)}</p>`,
  };
}

/** First ~140 characters of the first paragraph — the inbox preview line. */
function preheaderOf(body: string): string {
  const first = body.split(/\n{2,}/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

/**
 * Test sends are marked in the SUBJECT LINE, not just the send log: the whole
 * point is that a facilitator can tell at a glance, in their own inbox, that
 * what landed was a rehearsal. Matches the admin course-template test send.
 */
function envelopeSubject(subject: string, test: boolean): string {
  return test ? `[TEST] ${subject}` : subject;
}

type CommonEmailArgs = {
  /** One address. Callers dispatch per recipient — never a list. */
  to: string;
  subject: string;
  /** Plain text as typed by the sender. */
  body: string;
  /** Display name of the facilitator/admin sending. Never an email. */
  senderName: string;
  /** Sender's uid — the deliverability log's actor. */
  actorUid: string;
  /** True when this is a rehearsal to the sender's own address. */
  test: boolean;
};

/**
 * OPERATIONAL group mail: "your session moved", "bring the reading". Renders
 * through `ApplicationEmail` — the same transactional chrome the course
 * lifecycle mail uses — and deliberately carries NO unsubscribe affordance,
 * matching every other transactional path in the estate (task membership, RSVP,
 * collaborator lifecycle). Opting out of "your room changed" is not a thing a
 * member of a group can meaningfully do; the run announcement route is the
 * opt-outable lane. See the route's module comment for the full argument.
 */
export async function sendCourseGroupEmail(
  args: CommonEmailArgs & {
    groupId: string;
    groupName: string;
    /** Denormalised context for the signature line; omitted degrades cleanly. */
    courseTitle?: string | null;
    runLabel?: string | null;
  },
): Promise<void> {
  const context = [
    args.groupName,
    args.courseTitle
      ? `${args.courseTitle}${args.runLabel ? ` (${args.runLabel})` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" — ");

  const blocks: Block[] = [
    ...bodyToBlocks(args.body),
    { id: newBlockId(), type: "divider" },
    signatureBlock(args.senderName, context),
  ];

  await sendEmail({
    to: args.to,
    subject: envelopeSubject(args.subject, args.test),
    react: ApplicationEmail({
      subject: args.subject,
      blocks,
      preheader: preheaderOf(args.body),
    }),
    kind: args.test ? "course-test" : "course-facilitator",
    actorUid: args.actorUid,
    referenceId: args.groupId,
  });
}

/**
 * ANNOUNCEMENT mail to a whole run's cohort channel. Renders through
 * `NewsletterEmail` because that template already carries the unsubscribe
 * footer, and pairs it with the RFC 8058 `List-Unsubscribe` headers so inbox
 * clients render their own one-click control. Both point at the same signed
 * token, scoped to this run's channel — unsubscribing here drops the cohort
 * channel and nothing else.
 */
export async function sendCourseRunEmail(
  args: CommonEmailArgs & {
    runId: string;
    /** Greeting name for this recipient. Names only. */
    recipientName: string;
    courseTitle?: string | null;
    runLabel?: string | null;
    /** `/api/unsubscribe?t=<signed>` for THIS recipient and THIS run channel. */
    unsubscribeUrl: string;
  },
): Promise<void> {
  const context = args.courseTitle
    ? `${args.courseTitle}${args.runLabel ? ` (${args.runLabel})` : ""}`
    : (args.runLabel ?? "");

  const blocks: Block[] = [
    ...bodyToBlocks(args.body),
    { id: newBlockId(), type: "divider" },
    signatureBlock(args.senderName, context),
  ];

  await sendEmail({
    to: args.to,
    subject: envelopeSubject(args.subject, args.test),
    react: NewsletterEmail({
      subject: args.subject,
      blocks,
      recipientName: args.recipientName,
      unsubscribeUrl: args.unsubscribeUrl,
      preheader: preheaderOf(args.body),
    }),
    kind: args.test ? "course-test" : "course-broadcast",
    actorUid: args.actorUid,
    referenceId: args.runId,
    listUnsubscribe: {
      url: args.unsubscribeUrl,
      mailto: process.env.EMAIL_DEFAULT_REPLY_TO,
    },
  });
}
