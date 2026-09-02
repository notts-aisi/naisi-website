import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { readMirrorPlan, type RegisterOverride } from "@/lib/courses/attendanceMirror";
import { resolveWeekDoc } from "@/lib/courses/groupResolve";
import {
  gateGroupRegister,
  isAddressableId,
  loadRegisterMembers,
} from "@/lib/courses/registerAccess";
import { resolveSessions, type ResolvedSession } from "@/lib/courses/sessions";
import {
  dispatchSends,
  reserveSendSlot,
  resolveCohortAudience,
  type CohortRecipient,
} from "@/lib/email/courseFacilitatorEmails";
import {
  courseNudgeSessionDateKey,
  courseNudgeSessionWhen,
  courseNudgeSessionWhere,
  courseWeekPrepLine,
  courseWeekUrl,
  groupNudgeMarkerId,
  resolveCourseNudgeTemplate,
  sendCourseWeekNudgeEmail,
} from "@/lib/email/courseNudgeEmail";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import { attendanceDocId } from "@/lib/firestore/courseAttendance";
import { COURSE_AUDIT_COLLECTION } from "@/lib/firestore/courseAudit";
import { sessionModeForWeek } from "@/lib/firestore/courseGroups";
import { courseRunChannel, normalizeCourseRun } from "@/lib/firestore/courses";
import { readCoursesConfig } from "@/lib/firestore/config";
import { signToken } from "@/lib/signedTokens";

/**
 * PUSH ATTENDANCE: the one human action that closes a session.
 *
 * A facilitator marks the room as often as they like during the session; the
 * register is a draft the whole time. Pressing push does three things at once,
 * and the order they happen in is the whole design of this file:
 *
 *   1. THE REGISTER LOCKS. `pushedAt` and `pushedByUid` are stamped, POST
 *      refuses it from then on, and only an admin's PATCH can move a mark,
 *      each one logged.
 *   2. THE MIRRORS ARE REBUILT. Every member's `courseEnrolments.attendance`
 *      is recomputed IN FULL from this group's pushed registers. Never a
 *      delta: `applicationCounts` moves as relative increments, has no recount
 *      pass anywhere, and is therefore unreconcilable once it drifts. A mirror
 *      that can be rebuilt from its source at any time cannot drift at all.
 *   3. THE NEXT SESSION'S REMINDER GOES OUT, once, to the members of THIS
 *      GROUP, carrying the next week's material and the weekly feedback link.
 *
 * ── (1) AND (2) ARE ONE TRANSACTION. (3) IS NOT, AND MUST NOT BE. ───────────
 * A `.create()` collision inside a Firestore transaction aborts the WHOLE
 * transaction. If the send marker were claimed inside, then a second press,
 * a retry, or any race that found the marker taken would roll back the LOCK
 * and the MIRRORS as well: the register would come unlocked because an email
 * had already been sent, which is precisely backwards. So the transaction
 * commits first, and the marker is claimed by a standalone `.create()` after
 * it. A send failure after that point leaves the register locked and the
 * mirrors correct, which is the outcome we want, and the admin catch-up lane
 * (POST /api/courses/runs/[runId]/nudge, with `force`) is how the mail is
 * recovered.
 *
 * ── CLAIM BEFORE SEND ───────────────────────────────────────────────────────
 * The marker is claimed BEFORE the first message goes out, never after. That
 * trades "possible partial send" for "never a duplicate blast", the same trade
 * the run-level nudge documents at length. A missed reminder is a reminder; a
 * duplicate blast is an incident.
 *
 * ── A SECOND PRESS IS A 200, NOT AN ERROR ───────────────────────────────────
 * `{ ok: true, alreadyPushed: true }`. A facilitator pressing twice because
 * the first press was slow has done nothing wrong, and nothing happens twice.
 *
 * ── WHAT THIS ROUTE DOES NOT DO ─────────────────────────────────────────────
 * THE SESSION-1 WELCOME. There is no push before a run's first session, so
 * nothing here can send one. That send is the ADMIN CATCH-UP lane's job (the
 * run-level nudge), pressed by hand before the first week. Do not add a
 * "first session" branch here: it would need its own idempotency marker for a
 * send that happens once per run, and the catch-up lane already has one.
 * docs/courses-ops.md carries the operational half of this note.
 */

// ---------------------------------------------------------------------------
// Wire type
// ---------------------------------------------------------------------------

export type AttendancePushResult = {
  ok: true;
  sessionKey: string;
  /** True when this register was already pushed before this request. */
  alreadyPushed: boolean;
  /** Members whose rollup this push rewrote. Zero on an already-pushed press. */
  mirrored: number;
  /** Reminder emails that went out. */
  sent: number;
  /** Recipients dropped along the way: opted out, suppressed, failed. */
  skipped: number;
  /**
   * Why nothing was sent, when nothing was. Null when mail went out. Never a
   * failure: a locked register with no reminder is a complete outcome, and
   * this is what the confirm dialog reports back to the facilitator.
   */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_WEEK_NUMBER = 60;
const MAX_OCCURRENCE = 4;

const WINDOW_MS = 60 * 60 * 1000;
/**
 * Pushes per (sender, group) per hour. The marker is what actually prevents a
 * duplicate email; this bounds a stuck client hammering the endpoint. It is
 * spent BEFORE the transaction so a throttled request neither locks a register
 * nor sends anything.
 */
const PUSHES_PER_WINDOW = 8;

/** Same lifetime the newsletter gives its unsubscribe links. */
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

/** This lane's voice in the shared audience derivation. */
const LANE = {
  logTag: "courses push",
  overCapAdvice: "split the cohort",
} as const;

/**
 * ALREADY_EXISTS out of `.create()`. The Admin SDK surfaces the raw gRPC
 * status (6); the string forms are accepted because the emulator and some
 * transport paths report the canonical name instead.
 */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

class RegisterMissingError extends Error {}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

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

  // AUTHORIZATION BEFORE THE BODY IS PARSED: the same ordering the register
  // route holds, for the same reason.
  const gated = await gateGroupRegister(groupId, actor, db);
  if (!gated.ok) {
    return NextResponse.json({ error: gated.error }, { status: gated.status });
  }
  const { group, runId } = gated;

  let body: { weekNumber?: unknown; occurrence?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const weekNumber = body?.weekNumber;
  if (
    typeof weekNumber !== "number" ||
    !Number.isInteger(weekNumber) ||
    weekNumber < 1 ||
    weekNumber > MAX_WEEK_NUMBER
  ) {
    return NextResponse.json(
      { error: `weekNumber must be a whole number between 1 and ${MAX_WEEK_NUMBER}.` },
      { status: 400 },
    );
  }
  const rawOccurrence = body?.occurrence;
  const occurrence = rawOccurrence === undefined || rawOccurrence === null ? 1 : rawOccurrence;
  if (
    typeof occurrence !== "number" ||
    !Number.isInteger(occurrence) ||
    occurrence < 1 ||
    occurrence > MAX_OCCURRENCE
  ) {
    return NextResponse.json(
      { error: `occurrence must be a whole number between 1 and ${MAX_OCCURRENCE}.` },
      { status: 400 },
    );
  }

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    loadRegisterMembers(db, runId, groupId),
  ]);
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  // The session must be one THIS GROUP holds, recomputed rather than trusted.
  const sessions = resolveSessions(run, group);
  const index = sessions.findIndex(
    (s) => s.weekNumber === weekNumber && s.occurrence === occurrence,
  );
  if (index < 0) {
    return NextResponse.json(
      { error: `Week ${weekNumber} isn't a taught session of this group's schedule.` },
      { status: 400 },
    );
  }
  const session = sessions[index];
  const nextSession: ResolvedSession | null = sessions[index + 1] ?? null;

  // Spent BEFORE the transaction: a throttled request must neither lock a
  // register nor send. Fail CLOSED, the one safe direction for outbound mail.
  let slot;
  try {
    slot = await reserveSendSlot(db, {
      key: `push__${groupId}__${actor.uid}`,
      limit: PUSHES_PER_WINDOW,
      windowMs: WINDOW_MS,
    });
  } catch (err) {
    console.error("[courses push] throttle read failed", groupId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      { error: "That's a lot of pushes in one hour. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  // ── (1) + (2): LOCK AND MIRROR, IN ONE TRANSACTION ───────────────────────
  const ref = db
    .collection("courseAttendance")
    .doc(attendanceDocId(runId, groupId, session.weekNumber, session.occurrence));
  const now = new Date();
  let alreadyPushed = false;
  let mirrored = 0;

  try {
    await db.runTransaction(async (tx) => {
      alreadyPushed = false;
      mirrored = 0;
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegisterMissingError();
      const data = snap.data() ?? {};
      if (data.pushedAt) {
        // Nothing to do, and nothing to undo. Reported as a 200 outside.
        alreadyPushed = true;
        return;
      }

      // EVERY READ BEFORE EVERY WRITE. The plan reads this group's other
      // registers and its members' enrolments; the override is how the
      // register being stamped in THIS transaction gets counted, since a
      // transaction cannot read back its own write.
      const overrides = new Map<string, RegisterOverride>([
        [session.sessionKey, { pushedAt: now, held: data.held !== false }],
      ]);
      const plan = await readMirrorPlan(tx, db, {
        runId,
        groupId,
        sessions,
        members,
        overrides,
        now,
      });

      tx.set(
        ref,
        {
          pushedAt: Timestamp.fromDate(now),
          pushedByUid: actor.uid,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      for (const write of plan.writes) {
        tx.set(write.ref, { attendance: write.rollup }, { merge: true });
      }
      mirrored = plan.writes.length;

      tx.set(db.collection(COURSE_AUDIT_COLLECTION).doc(), {
        kind: "attendance-push",
        runId,
        groupId,
        subjectUid: null,
        actorUid: actor.uid,
        actorName: actor.displayName ?? "",
        targetLabel: `${session.sessionKey} register`,
        detail:
          `Pushed the week ${session.weekNumber} session ${session.occurrence} register for ${group.name || groupId}. ` +
          `${plan.writes.length} ${plan.writes.length === 1 ? "record" : "records"} recomputed.`,
        at: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof RegisterMissingError) {
      return NextResponse.json(
        {
          error:
            "Mark the register before pushing it. An empty session still needs the not-held switch.",
        },
        { status: 400 },
      );
    }
    throw err;
  }

  if (alreadyPushed) {
    const result: AttendancePushResult = {
      ok: true,
      sessionKey: session.sessionKey,
      alreadyPushed: true,
      mirrored: 0,
      sent: 0,
      skipped: 0,
      reason: "This register was already pushed, so nothing was sent again.",
    };
    return NextResponse.json(result);
  }

  // ── (3) THE REMINDER ─────────────────────────────────────────────────────
  // Everything from here is best effort against a register that is ALREADY
  // locked and mirrors that are ALREADY correct. No failure below may undo
  // either, and every early return is a 200 saying why no mail went.
  const done = (sent: number, skipped: number, reason: string | null) =>
    NextResponse.json({
      ok: true,
      sessionKey: session.sessionKey,
      alreadyPushed: false,
      mirrored,
      sent,
      skipped,
      reason,
    } satisfies AttendancePushResult);

  if (!nextSession) {
    return done(0, 0, "That was the group's last session, so there's nothing to remind them about.");
  }
  if (!nextSession.slotStartKey) {
    // The marker id is keyed on the next slot's date. Without dates there is
    // no key, and a send with no idempotency marker is one that can repeat.
    return done(0, 0, "This group has no dates set, so no reminder could be sent.");
  }

  // Resolved BEFORE the marker is claimed: an unpublished week is a reason not
  // to send at all, and claiming first would silence the reminder for good.
  const { week } = await resolveWeekDoc(db, runId, groupId, nextSession.weekId);
  if (!week || !week.published) {
    return done(
      0,
      0,
      `Week ${nextSession.weekNumber} isn't published yet, so the group wasn't sent a reminder. Publish it and use the run's catch-up send.`,
    );
  }

  const audience = await resolveCohortAudience(db, runId, LANE);
  if (audience.refusal) return done(0, audience.skipped, audience.refusal);
  const recipients: CohortRecipient[] = audience.members.filter(
    (m) => m.groupId === groupId,
  );
  let skipped = audience.skipped;
  if (recipients.length === 0) {
    // Deliberately does NOT claim the marker: an audience that is empty today
    // (everyone opted out, nobody allocated yet) must not permanently suppress
    // this reminder for whoever becomes deliverable tomorrow.
    return done(0, skipped, "Nobody in this group is set up to receive email, so none was sent.");
  }

  // ── CLAIM THE MARKER, OUTSIDE THE TRANSACTION ────────────────────────────
  // Deterministic id plus `.create()` IS the guarantee. It lives in
  // `courseNudges`, already locked `read, write: if false` as server-side
  // course-email bookkeeping, so this ships with no rules change.
  const markerRef = db
    .collection("courseNudges")
    .doc(groupNudgeMarkerId(runId, groupId, nextSession.slotStartKey));
  const stamp = Timestamp.fromDate(now);
  try {
    await markerRef.create({
      kind: "group-week-nudge",
      runId,
      groupId,
      // The next slot is the KEY; the rest is stored so the document reads as
      // something a human can interpret.
      slotStartKey: nextSession.slotStartKey,
      sessionKey: nextSession.sessionKey,
      weekNumber: nextSession.weekNumber,
      weekId: nextSession.weekId,
      pushedSessionKey: session.sessionKey,
      sentAt: stamp,
      sentByUid: actor.uid,
      recipientCount: recipients.length,
      // The run-level catch-up records a force over this marker in its own
      // document; these two fields exist so both families read alike.
      forceCount: 0,
      forces: [],
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // Another push (or the admin catch-up) already claimed this group's
    // reminder for the next session. The register is still locked, which is
    // the point of doing this after the commit.
    return done(0, skipped, "This group has already had the reminder for its next session.");
  }

  const config = await readCoursesConfig(db);
  const template = await resolveCourseNudgeTemplate(db);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const channel = courseRunChannel(runId);
  const sessionWhen = courseNudgeSessionWhen(
    nextSession.session,
    courseNudgeSessionDateKey(nextSession.slotStartKey, nextSession.session.weekday),
  );
  const sessionWhere = courseNudgeSessionWhere(
    nextSession.session,
    sessionModeForWeek(group, nextSession.weekId),
  );

  let sent = 0;
  // Bounded concurrency, not a sequential sleep: `dispatchSends` carries the
  // wall-clock arithmetic that keeps a full group send inside App Hosting's
  // 60s request timeout.
  await dispatchSends(recipients, async (recipient) => {
    // One token per recipient, scoped to THIS run's channel: clicking it drops
    // the cohort and nothing else.
    const token = signToken(
      { s: "unsubscribe", uid: recipient.uid, c: channel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(token)}`;
    try {
      // ONE address. One message. Never an array, never a Cc.
      await sendCourseWeekNudgeEmail({
        to: recipient.address,
        runId,
        actorUid: actor.uid,
        test: false,
        // The placeholder-free name: "" drops the greeting rather than
        // addressing a member as "NAISI".
        recipientName: recipient.ownName,
        sessionWhen,
        sessionWhere,
        unsubscribeUrl,
        template,
        context: {
          courseTitle: run.courseTitle,
          runLabel: run.label,
          weekNumber: nextSession.weekNumber,
          weekTitle: week.title,
          weekSummary: week.summary,
          weekPrep: courseWeekPrepLine(week),
          weekUrl: courseWeekUrl(appUrl, runId, nextSession.weekNumber),
          // Empty until an admin configures a form, and the renderer then
          // drops the paragraph whole rather than shipping a dead link.
          feedbackUrl: config.weeklyFeedbackUrl,
        },
      });
      sent += 1;
    } catch (err) {
      // Uid only: an address must not reach the logs.
      console.error("[courses push] send failed", groupId, recipient.uid, err);
      skipped += 1;
    }
  });

  console.log("[courses push] pushed", groupId, session.sessionKey, {
    mirrored,
    sent,
    skipped,
  });
  return done(sent, skipped, null);
}
