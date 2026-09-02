import { NextResponse } from "next/server";
import ApplicationEmail from "@/emails/ApplicationEmail";
import {
  dispatchSends,
  reserveSendSlot,
} from "@/lib/email/courseFacilitatorEmails";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseEnrolment } from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseRun } from "@/lib/firestore/courses";
import type { EmailSendKind } from "@/lib/firestore/emailSends";
import { newBlockId, type Block } from "@/lib/firestore/newsletterBlocks";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * ROOM NOTICE — the one-click "we've moved to B52 / we're on Zoom tonight"
 * blast to a group (v2 DECISION 8, cited): an OPERATIONAL lane that BYPASSES
 * the `courses` notification opt-out and HONOURS suppression, with a rate
 * limit that "must not block a genuine double-change evening: exemption or
 * higher cap WITH audit trail".
 *
 * The client prefills the message from a session or mode change; this route
 * takes `{ message: string }` and nothing else — no subject to compose, no
 * test lane, no recipients to choose. Friction is the enemy on a message
 * whose whole value is arriving before the session starts.
 *
 * ── DECISION 8: NOT OPT-OUTABLE, SUPPRESSION STILL ABSOLUTE ─────────────────
 * This is the group email route's operational-lane precedent, restated
 * because this route is judged against it: "your room moved tonight" is not
 * an announcement a member can meaningfully opt out of, so the `courses`
 * notification category and the marketing subscription are BOTH ignored, and
 * no unsubscribe footer is carried — matching every transactional path in
 * the estate. A SUPPRESSED address is different and is always skipped: a
 * bounce or complaint is a deliverability fact, not a preference.
 *
 * ── ONE MESSAGE PER RECIPIENT. NOT NEGOTIABLE. ──────────────────────────────
 * One `sendEmail` per address, a single string as `to`, no Cc/Bcc — the
 * group email route's argument verbatim: batching disclosure of members'
 * addresses to each other is the worst failure this lane can produce.
 * Recipients derive server-side from the group's own ACTIVE enrolments; the
 * caller supplies no uids and no addresses, and none come back (counts only).
 *
 * ── THE RATE LIMIT: 10/day PER GROUP, ON ITS OWN DURABLE COUNTER ────────────
 * A SEPARATE `reserveSendSlot` counter from the 3/hour group-email one
 * (different key prefix, so the two can never starve each other): notices
 * must survive the evening where the room changes twice and the mode flips
 * once — three sends inside an hour that the email lane's cap would refuse.
 * Keyed by GROUP, not by (sender, group): the cap protects members' inboxes
 * from the room's total traffic, whoever staffs it. Ten a day is far beyond
 * any honest evening while still bounding a runaway client. The AUDIT TRAIL
 * decision 8 demands is `emailSends`: every send logs there with kind
 * `course-notice`, actor uid and group id attached, via `sendEmail`'s
 * standard logging.
 *
 * ── WHO MAY SEND ────────────────────────────────────────────────────────────
 * A facilitator of THIS group while it is LIVE, ∪ admins — identical gate
 * and ordering to the group email route: AUTHORIZATION BEFORE EXISTENCE,
 * one indistinguishable 403.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Same refusal threshold as the group email route — refuse, never truncate. */
const MAX_MEMBERS = 100;

/** The pinned cap: 10 notices per GROUP per day, on a durable counter. */
const NOTICES_PER_WINDOW = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** A notice is a paragraph, not a newsletter. */
const MAX_MESSAGE = 1000;

/**
 * `emailSends` audit kind for this lane (decision 8's audit trail). A real
 * member of the `EmailSendKind` union now, not an assertion past it: the cast
 * this used to carry would have kept compiling if the kind were ever renamed or
 * the union re-owned, and an audit row is the last thing that should be typed
 * on trust. See `emailSends.ts` for why this lane gets its own kind.
 */
const NOTICE_KIND: EmailSendKind = "course-notice";

// ---------------------------------------------------------------------------
// Helpers (duplicated per route by house convention — no route inherits
// another's PII assumptions; see the group email route's displayNameOf note)
// ---------------------------------------------------------------------------

function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

/** ONE address per member — the group email route's rule, same reasoning. */
function deliveryAddressFor(
  data: Record<string, unknown>,
  gmailOnly: boolean,
): string | null {
  const account = typeof data.email === "string" ? data.email.trim() : "";
  if (account) return account;
  if (gmailOnly) return null;
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const uni =
    typeof profile.universityEmail === "string" ? profile.universityEmail.trim() : "";
  return uni && profile.uniEmailVerifiedAt ? uni : null;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Plain text → escaped richText blocks, the courseFacilitatorEmails shape:
 * escaping happens before any markup assembly, so a message containing
 * `<script>` lands as literal characters, never as markup.
 */
function messageBlocks(message: string, senderName: string, context: string): Block[] {
  const paragraphs = message
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const html = paragraphs
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
  const signature = context ? `${senderName} · ${context}` : senderName;
  return [
    { id: newBlockId(), type: "richText", html },
    { id: newBlockId(), type: "divider" },
    {
      id: newBlockId(),
      type: "richText",
      html: `<p style="margin:0;font-size:13px;color:#71717a">Sent by ${escapeHtml(signature)}</p>`,
    },
  ];
}

/** First ~140 characters — the inbox preview line. */
function preheaderOf(message: string): string {
  const first = message.split(/\n{2,}/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

type Recipient = { uid: string; address: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE, before the body is parsed — the group
  // email route's ordering, for its reasons.
  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !facilitatesLiveGroup) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  if (!group.runId) {
    return NextResponse.json(
      { error: "Group is not attached to a run" },
      { status: 400 },
    );
  }

  let message = "";
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
    }
    const m = (raw as Record<string, unknown>).message;
    message = typeof m === "string" ? m.replace(/\r\n/g, "\n").trim() : "";
  } catch {
    return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "A message is required." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE) {
    return NextResponse.json(
      { error: `Notices must be ${MAX_MESSAGE} characters or fewer.` },
      { status: 400 },
    );
  }

  // The subject is SYNTHESISED — never request text in a header. Group names
  // are capped at 80 chars, so this stays a single inbox-friendly line.
  const subject = `Session update — ${group.name}`;

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";

  // The group's ACTIVE members, same query and same `MAX_MEMBERS + 1`
  // oversize-detection as the group email route (refuse, never truncate).
  const [runSnap, actorSnap, memberSnap] = await Promise.all([
    db.collection("courseRuns").doc(group.runId).get(),
    db.collection("users").doc(actor.uid).get(),
    db
      .collection("courseEnrolments")
      .where("runId", "==", group.runId)
      .where("groupId", "==", groupId)
      .where("status", "==", "active")
      .limit(MAX_MEMBERS + 1)
      .get(),
  ]);

  const run = runSnap.exists
    ? normalizeCourseRun(runSnap.id, runSnap.data() ?? {})
    : null;
  const senderName = actorSnap.exists
    ? displayNameOf(actorSnap.data() ?? {})
    : actor.displayName?.trim() || "NAISI member";

  if (memberSnap.docs.length > MAX_MEMBERS) {
    return NextResponse.json(
      {
        error:
          `This group has more than ${MAX_MEMBERS} active members, over the limit for a ` +
          "single send. Nothing was sent — split the group or raise it with an admin.",
      },
      { status: 400 },
    );
  }

  let skipped = 0;
  const memberUids = memberSnap.docs
    .map((d) => normalizeCourseEnrolment(d.id, d.data() ?? {}).uid)
    .filter(Boolean);
  const userDocs = memberUids.length
    ? await db.getAll(...memberUids.map((uid) => db.collection("users").doc(uid)))
    : [];

  const recipients: Recipient[] = [];
  const seen = new Set<string>();
  for (const doc of userDocs) {
    if (!doc.exists) {
      skipped += 1;
      continue;
    }
    const address = deliveryAddressFor(doc.data() ?? {}, gmailOnly);
    if (!address) {
      skipped += 1;
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    recipients.push({ uid: doc.id, address });
  }

  if (recipients.length === 0) {
    // Nothing to send: don't spend a rate-limit slot on it — and therefore no
    // honest `remaining` to report, since nothing was claimed. The composer
    // reads an absent value as "unknown" and stays quiet rather than guessing.
    return NextResponse.json({ ok: true, sent: 0, skipped });
  }

  // SUPPRESSION IS ALWAYS HONOURED — the one filter this lane keeps.
  const { suppressed } = await filterSuppressed(
    db,
    recipients.map((r) => r.address),
  );
  const suppressedSet = new Set(suppressed.map((a) => a.toLowerCase()));
  const deliverable = recipients.filter(
    (r) => !suppressedSet.has(r.address.toLowerCase()),
  );
  skipped += recipients.length - deliverable.length;
  if (deliverable.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped });
  }

  // THE 10/DAY PER-GROUP COUNTER — its own key prefix, so the group email
  // route's 3/hour (sender, group) budget and this one can never starve each
  // other. Claimed immediately before dispatch; a request that dies mid-send
  // has still spent it (reserve-before-send, fail closed).
  let slot;
  try {
    slot = await reserveSendSlot(db, {
      key: `groupnotice__${groupId}`,
      limit: NOTICES_PER_WINDOW,
      windowMs: WINDOW_MS,
    });
  } catch (err) {
    console.error("[courses group notice] throttle read failed", groupId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      {
        error: `This group has already sent ${NOTICES_PER_WINDOW} notices in the last day. Try again later, or use the group email lane.`,
      },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  const context = [
    group.name,
    run?.courseTitle
      ? `${run.courseTitle}${run.label ? ` (${run.label})` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" — ");
  const blocks = messageBlocks(message, senderName, context);
  const preheader = preheaderOf(message);

  let sent = 0;
  // Bounded concurrency via the shared dispatcher — its wall-clock arithmetic
  // against the 60s request ceiling lives on the helper.
  await dispatchSends(deliverable, async (recipient) => {
    try {
      // ONE address. One message. See the header.
      await sendEmail({
        to: recipient.address,
        subject,
        react: ApplicationEmail({ subject, blocks, preheader }),
        kind: NOTICE_KIND,
        actorUid: actor.uid,
        referenceId: groupId,
      });
      sent += 1;
    } catch (err) {
      // Uid only — an address must not reach the logs.
      console.error("[courses group notice] send failed", groupId, recipient.uid, err);
      skipped += 1;
    }
  });

  // `remaining` is the claim's own answer (see `reserveSendSlot`) — the slots
  // left in this group's 10-a-day window after the send that just happened.
  // The composer renders it as the cap warning; it was reading a field this
  // route never returned, so the warning could not appear at all until the day
  // the cap actually bit.
  return NextResponse.json({ ok: true, sent, skipped, remaining: slot.remaining });
}
