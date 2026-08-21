import "server-only";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import ApplicationEmail from "@/emails/ApplicationEmail";
import NewsletterEmail from "@/emails/NewsletterEmail";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import {
  courseRunChannel,
  normalizeCourseRun,
  type CourseRunDoc,
} from "@/lib/firestore/courses";
import { newBlockId, type Block } from "@/lib/firestore/newsletterBlocks";
import { findRecipientsForChannel } from "@/lib/firestore/subscriptions";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { sendEmail } from "./send";

/**
 * The send-side machinery for COHORT- AND GROUP-ADDRESSED course mail — the two
 * P9 email routes (`/api/courses/groups/[groupId]/email`,
 * `/api/courses/runs/[runId]/email`) and P11's weekly nudge
 * (`/api/courses/runs/[runId]/nudge`). Templates, payload validation, the
 * durable send throttle, the run-staff gate and the cohort audience derivation
 * live together because the routes must agree on all of them; route handlers
 * don't import from one another by house convention, so this module is where
 * they meet.
 *
 * ── WHO MAY SEND AND WHO RECEIVES ARE DEFINED ONCE, HERE ────────────────────
 * `gateRunStaff` and `resolveCohortAudience` were previously written out twice,
 * line for line, in the announcement route and the nudge route — with a comment
 * in each saying "IF YOU CHANGE ONE, CHANGE BOTH". They are the same predicate
 * and the same audience by design (a nudge IS an announcement to the whole run),
 * so they are now one function each and the comment is retired. The extraction
 * was a pure move: both routes' status codes, refusal sentences, `skipped`
 * arithmetic, log tags and read ordering are unchanged.
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
// The run-staff gate
// ---------------------------------------------------------------------------

/** Same one-path-segment guard as `runAccess.ts` and the sibling routes. */
export function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

export type RunStaffGate =
  | { ok: true; actor: SessionUser; db: Firestore; run: CourseRunDoc; isAdmin: boolean }
  /** Map straight onto a `NextResponse.json({ error }, { status })`. */
  | { ok: false; status: number; error: string };

/**
 * WHO MAY ADDRESS A WHOLE RUN: the run's `runFacilitatorUids` ∪ its
 * `trackLeadUids` ∪ admins. Facilitating ONE GROUP of the run is deliberately
 * not enough — a group facilitator mails their own room through the group
 * route; addressing the whole cohort is a run-level act. Admissions reviewers
 * get nothing here: admissions is a separate lane from the cohort (locked
 * decision), and reading applications has never granted the ability to mail
 * applicants.
 *
 * AUTHORIZATION RUNS BEFORE ANY EXISTENCE CHECK — a missing run and a run you
 * hold no role on are the same 403, so probing run ids discloses nothing (the
 * same non-disclosure `runAccess.ts` gives). The 404-before-401 ordering on a
 * malformed id is deliberate too: it never reaches a document.
 *
 * Returns a plain status + sentence rather than a `NextResponse` so this module
 * stays free of `next/server`; each route renders its own response.
 */
export async function gateRunStaff(runId: string): Promise<RunStaffGate> {
  if (!isAddressableId(runId)) {
    return { ok: false, status: 404, error: "Run not found" };
  }

  const actor = await getCurrentUser();
  if (!actor) return { ok: false, status: 401, error: "Not signed in" };

  const db = getAdminDb();
  if (!db) return { ok: false, status: 500, error: "Server not configured" };

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  const run = runSnap.exists
    ? normalizeCourseRun(runSnap.id, runSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  const staffsRun = Boolean(
    run &&
      (run.runFacilitatorUids.includes(actor.uid) ||
        run.trackLeadUids.includes(actor.uid)),
  );
  if (!isAdmin && !staffsRun) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (!run) {
    return { ok: false, status: 404, error: "Run not found" };
  }

  return { ok: true, actor, db, run, isAdmin };
}

// ---------------------------------------------------------------------------
// Recipient identity
// ---------------------------------------------------------------------------

/**
 * The name a cohort email falls back to when a member has filled in neither a
 * preferred name nor a display name.
 *
 * IT IS NOT ALWAYS THE RIGHT FALLBACK. `NewsletterEmail` renders a greeting of
 * its own and needs *something*, so the announcement lane uses it. The weekly
 * nudge greets with `{firstName}`, and `firstWord("NAISI member")` is "NAISI" —
 * "Hi NAISI," — so it uses `memberNameOf` instead and lets its renderer drop
 * the greeting line entirely. Hence two functions rather than one.
 */
export const COURSE_MEMBER_PLACEHOLDER = "NAISI member";

/**
 * Preferred name, then account name, then "" — NEVER an email address, and
 * never a placeholder. "" means "we do not know this person's name".
 */
export function memberNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    ""
  );
}

/** `memberNameOf` with the neutral placeholder applied. */
export function displayNameOf(data: Record<string, unknown>): string {
  return memberNameOf(data) || COURSE_MEMBER_PLACEHOLDER;
}

/**
 * An EXPLICIT refusal, read off the raw stored prefs — deliberately not
 * `normaliseNotifications`, which collapses "absent" and "false" into the same
 * `false` and would turn every unanswered profile into an opt-out. Only the
 * modern `notifications` shape can carry this refusal; the legacy `newsletter`
 * shape predates the category entirely and never means "no" to it. The
 * subscription row is the opt-IN; this category is the opt-OUT layered on top.
 */
export function hasOptedOutOfCourseAnnouncements(
  data: Record<string, unknown>,
): boolean {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const notifications = profile.notifications;
  if (!notifications || typeof notifications !== "object") return false;
  const categories = (notifications as Record<string, unknown>).categories;
  if (!categories || typeof categories !== "object") return false;
  return (categories as Record<string, unknown>).courses === false;
}

/** The sender's own address, for a `testOnly` rehearsal. Never a body field. */
export function ownAddressFor(
  data: Record<string, unknown>,
  sessionEmail: string | null,
  gmailOnly: boolean,
): string | null {
  const account = typeof data.email === "string" ? data.email.trim() : "";
  if (account) return account;
  const session = sessionEmail?.trim();
  if (session) return session;
  if (gmailOnly) return null;
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const uni =
    typeof profile.universityEmail === "string" ? profile.universityEmail.trim() : "";
  return uni && profile.uniEmailVerifiedAt ? uni : null;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Drop the addresses the suppression list refuses, and say how many went.
 *
 * SUPPRESSION OUTRANKS EVERY PREFERENCE: a bounce or a complaint is a
 * deliverability fact, not a choice. It applies to a one-address rehearsal
 * exactly as it does to a 200-person cohort — a sender whose own address has
 * bounced needs to learn that from the test, not from a silent cohort send.
 */
export async function dropSuppressed<T extends { address: string }>(
  db: Firestore,
  list: readonly T[],
): Promise<{ deliverable: T[]; dropped: number }> {
  if (list.length === 0) return { deliverable: [], dropped: 0 };
  const { suppressed } = await filterSuppressed(
    db,
    list.map((r) => r.address),
  );
  const suppressedSet = new Set(suppressed.map((a) => a.toLowerCase()));
  const deliverable = list.filter((r) => !suppressedSet.has(r.address.toLowerCase()));
  return { deliverable, dropped: list.length - deliverable.length };
}

// ---------------------------------------------------------------------------
// The cohort audience — subscription ∩ active enrolment
// ---------------------------------------------------------------------------

/**
 * ALWAYS A MEMBER. Every recipient of cohort mail holds an active enrolment on
 * the run, and an enrolment is uid-keyed, so there is no guest shape here and no
 * email-shape unsubscribe token: a uid token flips the cohort row for BOTH of
 * that member's addresses, which an email-shape token could not.
 */
export type CohortRecipient = {
  uid: string;
  address: string;
  /** Preferred → display → "NAISI member". What a forced greeting needs. */
  recipientName: string;
  /** The same chain WITHOUT the placeholder — "" when we know no name. */
  ownName: string;
  /** Their placement on this run; null when accepted but not yet allocated. */
  groupId: string | null;
};

export type CohortAudience = {
  /** Deliverable: deduped, enrolment-verified, opt-out honoured, unsuppressed. */
  members: CohortRecipient[];
  /** Everyone dropped along the way. Counts only, never addresses. */
  skipped: number;
  /** Deduped + enrolment-verified — the number the recipient cap judges. */
  enrolledCount: number;
  /** Non-null when the caller must REFUSE rather than send. */
  refusal: string | null;
};

/**
 * The two strings that differ between the announcement lane and the nudge lane,
 * and the only reason this function takes a third argument.
 *
 * Both are OBSERVABLE: the log tag is what an operator greps for when a cohort
 * reports missing mail, and the advice completes a sentence a sender reads in
 * the composer. Unifying them would have been a silent copy change to a live P9
 * surface, which is a worse trade than two fields.
 */
export type CohortAudienceLane = {
  /** Console prefix, e.g. "courses run email". Named without brackets. */
  logTag: string;
  /** Completes "Nothing was sent — {advice} or raise it with an admin." */
  overCapAdvice: string;
};

/** Hard ceiling per request. Beyond this a send FAILS — see below. */
export const MAX_COHORT_RECIPIENTS = 200;

/**
 * Sanity ceiling on the channel read, above the recipient cap on purpose: it
 * catches a malformed channel (or a future many-rows-per-member scheme) rather
 * than sizing a normal cohort. Exceeding it FAILS the request.
 */
export const MAX_COHORT_CHANNEL_ROWS = 500;

/**
 * WHO RECEIVES COHORT MAIL: the rows `findRecipientsForChannel(cohort:<runId>)`
 * returns, INTERSECTED with the members holding an ACTIVE `courseEnrolments` row
 * on this run. Both halves are load-bearing and NEITHER IS SUFFICIENT ALONE:
 *
 *  · The SUBSCRIPTION is what makes unsubscribe work. An enrolment-derived
 *    audience would silently re-mail everyone who clicked the footer link,
 *    because that link flips the row, not the enrolment.
 *  · The ENROLMENT is what makes the audience TRUE. `/api/subscriptions` is
 *    public and unauthenticated, run ids are public (the apply page renders
 *    `runId` into the client), and a signed-in caller subscribing one of their
 *    own verified addresses is minted confirmed with no click — so a
 *    subscription row alone is not a membership claim this may trust.
 *    `isServerManagedChannel` now refuses `cohort:` at that endpoint; THIS is
 *    the half that does not depend on every future write path remembering to
 *    ask.
 *
 * GUEST ROWS ARE DROPPED, not merely unverified. An enrolment is uid-keyed, so a
 * guest row can never hold one, and no legitimate producer writes one.
 *
 * THE ENROLMENT FILTER RUNS BEFORE THE RECIPIENT CAP, deliberately. Cap first
 * and anyone able to add rows to the channel could hold a cohort's mail hostage
 * by pushing the count past the ceiling — a refusal that, by design, refuses the
 * whole send. Counting the VERIFIED audience makes the cap a statement about the
 * cohort rather than about whoever wrote rows.
 *
 * SUPPRESSION IS APPLIED HERE, not at the call site, so a preview's count and
 * the send's count are the same number.
 *
 * `notifications.categories.courses` defaults FALSE like every other category,
 * and requiring it to be true would empty the audience on day one — nothing sets
 * it on placement. That is not what the toggle is for: the OPT-IN is the
 * subscription row (you were placed in a group; you consented by enrolling), and
 * the CATEGORY is the opt-out layered on top. So an explicit `courses === false`
 * skips a recipient and absent means "hasn't answered".
 * `DEFAULT_NOTIFICATION_PREFS` in notifications.ts carries the other half of this
 * comment; change neither alone.
 */
export async function resolveCohortAudience(
  db: Firestore,
  runId: string,
  lane: CohortAudienceLane,
): Promise<CohortAudience> {
  const channel = courseRunChannel(runId);
  let skipped = 0;

  const rows = await findRecipientsForChannel(db, channel);
  // Refuse rather than slice. A `slice()` here would be a silent truncation
  // wearing a cost-ceiling costume: dedupe runs AFTER it, so a cohort with
  // enough second-address rows could fall under the cap having already lost
  // people, and the send would look complete. Unreachable in practice (one row
  // per member) — which is exactly why it must fail loudly if it ever happens.
  if (rows.length > MAX_COHORT_CHANNEL_ROWS) {
    console.error(`[${lane.logTag}] channel row count exceeds ceiling`, runId, rows.length);
    return {
      members: [],
      skipped: 0,
      enrolledCount: 0,
      refusal:
        "This cohort's subscriber list is larger than a single send can handle. " +
        "Nothing was sent — raise it with an admin.",
    };
  }

  // Dedupe at the RECIPIENT level, not the address level: a member with both a
  // claimed guest row and a user row must get one email, not two. Same guard
  // the newsletter route carries.
  const seenAudience = new Set<string>();
  const seenAddress = new Set<string>();
  type Pending = { uid: string; audience: "user" | "guest"; address: string };
  const pending: Pending[] = [];
  for (const row of rows) {
    const dedupKey = `${row.audience}:${row.audienceId}`;
    if (seenAudience.has(dedupKey)) continue;
    seenAudience.add(dedupKey);
    const address = row.email.trim();
    if (!address) {
      skipped += 1;
      continue;
    }
    const addressKey = address.toLowerCase();
    if (seenAddress.has(addressKey)) {
      skipped += 1;
      continue;
    }
    seenAddress.add(addressKey);
    pending.push({
      uid: row.audience === "user" ? row.audienceId : "",
      audience: row.audience,
      address,
    });
  }

  // ── THE SUBSCRIPTION ROW IS NOT AUTHORITY. RE-VERIFY THE ENROLMENT. ───────
  // `courseEnrolmentId(runId, uid)` is deterministic, so this is ONE addressed
  // `getAll` over the deduped audience — no query, no index, one read per
  // candidate, bounded by MAX_COHORT_CHANNEL_ROWS above.
  const guestRows = pending.filter((p) => p.audience !== "user" || !p.uid);
  if (guestRows.length > 0) {
    skipped += guestRows.length;
    // A guest row on a cohort channel has no legitimate producer. Counted and
    // logged as an anomaly worth noticing, never as an address.
    console.warn(
      `[${lane.logTag}] guest rows on a cohort channel, dropped`,
      runId,
      guestRows.length,
    );
  }
  const memberPending = pending.filter((p) => p.audience === "user" && p.uid);
  const pendingByEnrolmentId = new Map<string, Pending>();
  for (const p of memberPending) {
    pendingByEnrolmentId.set(courseEnrolmentId(runId, p.uid), p);
  }
  const enrolmentIds = [...pendingByEnrolmentId.keys()];
  const enrolmentDocs = enrolmentIds.length
    ? await db.getAll(
        ...enrolmentIds.map((id) => db.collection("courseEnrolments").doc(id)),
      )
    : [];
  // Keyed by doc id rather than by result order, so this doesn't rest on
  // `getAll` returning documents in the order they were requested.
  const enrolled: Array<Pending & { groupId: string | null }> = [];
  for (const doc of enrolmentDocs) {
    if (!doc.exists) continue;
    const p = pendingByEnrolmentId.get(doc.id);
    if (!p) continue;
    const enrolment = normalizeCourseEnrolment(doc.id, doc.data() ?? {});
    // `runId` and `uid` are re-read off the document rather than inferred from
    // the id the lookup was built from — the id is construct-only by contract,
    // and a row that disagrees with it is not one to mail on.
    if (
      enrolment.status === "active" &&
      enrolment.runId === runId &&
      enrolment.uid === p.uid
    ) {
      enrolled.push({ ...p, groupId: enrolment.groupId });
    }
  }
  const notEnrolled = memberPending.length - enrolled.length;
  if (notEnrolled > 0) {
    skipped += notEnrolled;
    // Counts only. A non-zero value here is either a stale row (someone left and
    // the remove route's unsubscribe failed) or an attempt to join a cohort by
    // subscribing to it — both worth seeing, neither worth naming.
    console.warn(
      `[${lane.logTag}] subscribed rows with no active enrolment, skipped`,
      runId,
      notEnrolled,
    );
  }

  // REFUSE, don't truncate. Counted on the deduped, ENROLMENT-VERIFIED audience
  // BEFORE any preference filtering, so the answer doesn't wobble with who has
  // opted out this week — and before the cap, so anyone able to write channel
  // rows can't hold a cohort's mail hostage by pushing the count over.
  if (enrolled.length > MAX_COHORT_RECIPIENTS) {
    return {
      members: [],
      skipped,
      enrolledCount: enrolled.length,
      refusal:
        `This cohort has ${enrolled.length} subscribers, over the ${MAX_COHORT_RECIPIENTS}-recipient ` +
        `limit for a single send. Nothing was sent — ${lane.overCapAdvice} or raise it with an admin.`,
    };
  }

  // Names + the opt-out check, one `getAll` over the verified members.
  const memberUids = enrolled.map((p) => p.uid);
  const userDocs = memberUids.length
    ? await db.getAll(...memberUids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const dataByUid = new Map<string, Record<string, unknown>>();
  for (const doc of userDocs) {
    if (doc.exists) dataByUid.set(doc.id, doc.data() ?? {});
  }

  let optedOut = 0;
  const members: CohortRecipient[] = [];
  for (const p of enrolled) {
    const data = dataByUid.get(p.uid);
    if (!data) {
      // Subscribed row whose account is gone. Skip rather than mail an address
      // we can no longer attribute to a member.
      skipped += 1;
      continue;
    }
    if (hasOptedOutOfCourseAnnouncements(data)) {
      optedOut += 1;
      skipped += 1;
      continue;
    }
    const ownName = memberNameOf(data);
    members.push({
      uid: p.uid,
      address: p.address,
      recipientName: ownName || COURSE_MEMBER_PLACEHOLDER,
      ownName,
      groupId: p.groupId,
    });
  }
  if (optedOut > 0) {
    // Counts only, never addresses. A cohort where this climbs is the signal
    // that the profile toggle's default is wrong.
    console.log(
      `[${lane.logTag}] recipients opted out of course announcements`,
      runId,
      optedOut,
    );
  }

  if (members.length === 0) {
    return { members, skipped, enrolledCount: enrolled.length, refusal: null };
  }

  const { deliverable, dropped } = await dropSuppressed(db, members);
  return {
    members: deliverable,
    skipped: skipped + dropped,
    enrolledCount: enrolled.length,
    refusal: null,
  };
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
