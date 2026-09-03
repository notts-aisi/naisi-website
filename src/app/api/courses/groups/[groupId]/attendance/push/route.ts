import { NextResponse } from "next/server";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { readMirrorPlan, type RegisterOverride } from "@/lib/courses/attendanceMirror";
import { resolveWeekDoc } from "@/lib/courses/groupResolve";
import {
  gateGroupRegister,
  isAddressableId,
  loadMirrorMembers,
} from "@/lib/courses/registerAccess";
import {
  resolveSessions,
  sessionInstants,
  type ResolvedSession,
} from "@/lib/courses/sessions";
import {
  followUpDueAt,
  registerFollowUpTaskId,
} from "@/lib/courses/unmarkedRegisters";
import {
  dispatchSends,
  reserveSendSlot,
  resolveCohortAudience,
  type CohortRecipient,
} from "@/lib/email/courseFacilitatorEmails";
import {
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
import { REGISTER_FOLLOW_UP_TASK_SOURCE } from "@/lib/firestore/courseTasks";
import { courseRunChannel, normalizeCourseRun } from "@/lib/firestore/courses";
import {
  DEFAULT_COURSES_CONFIG,
  readCoursesConfig,
  type CoursesConfig,
} from "@/lib/firestore/config";
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
 *   4. THE FOLLOW-UP CARD CLOSES. If the register had gone unmarked long
 *      enough for the scheduler to raise a committee task about it, that task
 *      is archived here: the push is the one thing the card asked for. Best
 *      effort, after the commit, and free (no reads at all) on any register
 *      pushed before the grace has passed. See `archiveRegisterFollowUp`.
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
 * ── `{ force: true }`: THE ADMIN'S PER-GROUP RESEND ─────────────────────────
 * The claim-before-send trade above has one bad outcome: a transport failure
 * after the claim leaves a locked register, correct mirrors, and a group that
 * was never mailed, with the marker taken so a second press does nothing. The
 * only lane that used to reach them was the run-wide catch-up, which mails
 * every OTHER group of the run a second time to fix one.
 *
 * So an ADMIN may POST `{ force: true }` against a pushed register. It skips
 * the "already pushed" early return, re-derives the same audience, and updates
 * the existing marker with `forceCount`, `lastForcedAt`, `lastForcedByUid` and
 * a `forces` entry, the shape the run-level nudge writes for its own forces.
 * A facilitator is refused 403: the marker exists to stop a group being mailed
 * the same reminder every evening, and it must not be theirs to overwrite.
 *
 * Everything the mail needs (the config, the template) is now resolved BEFORE
 * the claim, so the ONLY thing that can fail after it is the transport itself.
 *
 * ── AN EMPTY HELD REGISTER IS REFUSED ───────────────────────────────────────
 * The participant-note lane creates the register document with a merge, so
 * "the register exists" stopped meaning "somebody marked the room". A held
 * session with no marks would push and count every eligible member absent, so
 * it is refused with the same sentence a missing register gets. Both refusals
 * are read BEFORE the throttle slot is spent: eight taps on an empty column
 * must not lock a facilitator out of pushing the register they then mark.
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
   * True when an admin RE-SENT this group's reminder over a marker that was
   * already claimed. The marker records who forced it and how often; this is
   * the same fact travelling back to the screen that asked for it.
   */
  forced: boolean;
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

/**
 * This lane's voice in the shared audience derivation.
 *
 * The advice names the GROUP, not the cohort, because the audience is now
 * resolved with `{ groupId }` and the ceiling is counted on this group's
 * active enrolments. A group over the cap is a group that needs splitting; the
 * size of the run it belongs to has nothing to do with it.
 */
const LANE = {
  logTag: "courses push",
  overCapAdvice: "split the group",
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
/** A HELD session with not one mark on it. See `isEmptyHeldRegister`. */
class RegisterEmptyError extends Error {}

/**
 * One sentence for both "there is no register" and "the register is empty",
 * because they are the same mistake from the facilitator's side and the remedy
 * is the same: mark the room, or say the session did not happen.
 */
const EMPTY_REGISTER_MESSAGE =
  "Mark the register before pushing it. An empty session still needs the not-held switch.";

/**
 * A held session carrying no marks at all.
 *
 * The participant-note lane writes with `set(..., { merge: true })`, so a note
 * or a session note CREATES the register document. Without this check the
 * push's "no register" guard is defeated by a note: a held session with an
 * empty `records` map would push, and the rollup counts every eligible member
 * of the group absent for a session nobody marked.
 *
 * Raw keys, not the normalised map: a document already carrying junk under
 * `records` is one somebody has marked, and this guard is about the empty one.
 */
function isEmptyHeldRegister(data: Record<string, unknown>): boolean {
  if (data.held === false) return false;
  const records = data.records;
  if (!records || typeof records !== "object") return true;
  return Object.keys(records as Record<string, unknown>).length === 0;
}

/**
 * How many follow-up cards the fallback query will close. One is the real
 * answer; the limit exists so a corrupt pointer cannot turn a push into an
 * unbounded write.
 */
const MAX_FOLLOW_UPS_CLOSED = 5;

/**
 * CLOSE THE UNMARKED-REGISTER FOLLOW-UP, if the scheduler raised one.
 *
 * The push is the exact thing the card asks for, so the card has no business
 * outliving it. Archived rather than deleted: the committee board hides
 * archived tasks by default, and the chase stays on the record.
 *
 * TWO LOOKUPS, cheapest first, and neither of them runs on the ordinary path.
 *  0. NO READS AT ALL before the grace has passed. A register pushed the same
 *     evening cannot have a card, and that is the overwhelming majority of
 *     pushes, so the whole helper returns on one date comparison.
 *  1. THE DETERMINISTIC ID, which is where the card is in every normal case.
 *  2. A QUERY ON THE POINTER, which is where it is when the deterministic id
 *     was already occupied by somebody else's task and the job fell back to
 *     its alternative id. `sourceRef` is the right thing to query on: no
 *     client can set it at create (firestore.rules pins it null) and no
 *     committee member can move it afterwards (pinned equal), so a row that
 *     matches really was minted by the tick.
 *
 * Two equality filters plus a third, all on auto-indexed fields (map
 * subfields are indexed like top-level ones and Firestore merges them), so no
 * composite index is owed and none was added.
 *
 * BEST EFFORT, always. The register is locked and the mirrors are rebuilt
 * before this is called; a failure here leaves a card an admin ticks by hand.
 */
async function archiveRegisterFollowUp(
  db: Firestore,
  opts: {
    runId: string;
    groupId: string;
    session: ResolvedSession;
    now: Date;
    graceHours: number;
  },
): Promise<void> {
  const { runId, groupId, session, now, graceHours } = opts;
  try {
    const endsAt = sessionInstants(session).endsAt;
    if (endsAt === null) return;
    if (now.getTime() < followUpDueAt(endsAt, graceHours).getTime()) return;

    const patch = { archived: true, updatedAt: FieldValue.serverTimestamp() };
    /** The card, and only the card: source AND the pointer it was aimed with. */
    const isOurs = (data: Record<string, unknown> | undefined): boolean => {
      if (!data || data.source !== REGISTER_FOLLOW_UP_TASK_SOURCE) return false;
      const ref = data.sourceRef as Record<string, unknown> | null | undefined;
      return (
        Boolean(ref) &&
        ref?.groupId === groupId &&
        ref?.sessionKey === session.sessionKey
      );
    };

    const primary = db
      .collection("tasks")
      .doc(registerFollowUpTaskId(runId, groupId, session.sessionKey));
    const snap = await primary.get();
    if (snap.exists && isOurs(snap.data())) {
      await primary.update(patch);
      return;
    }

    const found = await db
      .collection("tasks")
      .where("source", "==", REGISTER_FOLLOW_UP_TASK_SOURCE)
      .where("sourceRef.groupId", "==", groupId)
      .where("sourceRef.sessionKey", "==", session.sessionKey)
      .limit(MAX_FOLLOW_UPS_CLOSED)
      .get();
    await Promise.all(
      found.docs
        .filter((doc) => !doc.data().archived)
        .map((doc) => doc.ref.update(patch)),
    );
  } catch (err) {
    console.error(
      "[courses push] could not close the unmarked-register follow-up",
      groupId,
      session.sessionKey,
      err,
    );
  }
}

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
  const { group, runId, isAdmin } = gated;

  let body: { weekNumber?: unknown; occurrence?: unknown; force?: unknown };
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
  if (body?.force !== undefined && typeof body.force !== "boolean") {
    return NextResponse.json({ error: "force must be true or false." }, { status: 400 });
  }
  const force = body?.force === true;
  // ADMIN ONLY, and refused rather than ignored. A facilitator whose push
  // half-failed asks an admin; a facilitator who can re-send at will can mail
  // their group the same reminder every evening, and the marker that exists to
  // make that impossible would be theirs to overwrite.
  if (force && !isAdmin) {
    return NextResponse.json(
      { error: "Only an admin can re-send a reminder that has already gone." },
      { status: 403 },
    );
  }

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    loadMirrorMembers(db, runId, groupId),
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

  const ref = db
    .collection("courseAttendance")
    .doc(attendanceDocId(runId, groupId, session.weekNumber, session.occurrence));

  // ── REFUSALS THAT COST NO THROTTLE SLOT ──────────────────────────────────
  // A tap on a column with nothing in it is a mistake, not a send, and eight
  // of them must not lock a facilitator out of pushing the register they then
  // go and mark. So the two "there is nothing here to push" answers are read
  // ONCE, cheaply, before the slot is spent. The transaction re-reads both
  // authoritatively: this pre-read is a courtesy, never the guarantee.
  const preSnap = await ref.get();
  const preData = preSnap.exists ? (preSnap.data() ?? {}) : null;
  if (!preData) {
    return NextResponse.json({ error: EMPTY_REGISTER_MESSAGE }, { status: 400 });
  }
  if (!preData.pushedAt && isEmptyHeldRegister(preData)) {
    return NextResponse.json({ error: EMPTY_REGISTER_MESSAGE }, { status: 400 });
  }

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
        // Nothing to do, and nothing to undo. Reported as a 200 outside, or
        // carried on into the reminder lane when an admin is forcing a resend.
        alreadyPushed = true;
        return;
      }
      // The empty-held guard, re-read inside the transaction so a note written
      // between the pre-read and here cannot slip an unmarked room past it.
      if (isEmptyHeldRegister(data)) throw new RegisterEmptyError();

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
    if (err instanceof RegisterMissingError || err instanceof RegisterEmptyError) {
      return NextResponse.json({ error: EMPTY_REGISTER_MESSAGE }, { status: 400 });
    }
    throw err;
  }

  // ── THE FOLLOW-UP TASK CLOSES ────────────────────────────────────────────
  // Read AFTER the commit and best effort, like everything below it: the
  // register is locked and the mirrors are correct whatever happens here, and
  // a task left open is a card an admin ticks by hand rather than a lost
  // register. Placed ABOVE the already-pushed early return on purpose, so a
  // second press also closes a card the first press could not.
  //
  // The config is read here rather than further down because the archive
  // needs the grace to know whether a card can exist at all. It is still read
  // BEFORE the send marker is claimed, which is the property the reminder
  // lane below depends on.
  //
  // GUARDED, because this read now sits above the already-pushed early return
  // and therefore on the path of an ordinary second press. An unguarded throw
  // there would turn a harmless second press into a 500 AFTER the register was
  // committed, which reads to the facilitator as "the push failed" about a
  // push that succeeded. A failure leaves `config` null instead; the archive
  // falls back to the default grace (best effort over a card that may not
  // exist) and the reminder lane below refuses to send rather than mailing the
  // cohort with default copy.
  let config: CoursesConfig | null = null;
  try {
    config = await readCoursesConfig(db);
  } catch (err) {
    console.error("[courses push] course settings read failed", groupId, err);
  }
  await archiveRegisterFollowUp(db, {
    runId,
    groupId,
    session,
    now,
    graceHours: (config ?? DEFAULT_COURSES_CONFIG).unmarkedRegisterGraceHours,
  });

  // An ordinary second press. An admin FORCING a resend carries on into the
  // reminder lane instead: that is the whole point of the force, and the
  // register is already locked and mirrored either way.
  if (alreadyPushed && !force) {
    const result: AttendancePushResult = {
      ok: true,
      sessionKey: session.sessionKey,
      alreadyPushed: true,
      mirrored: 0,
      sent: 0,
      skipped: 0,
      forced: false,
      reason: "This register was already pushed, so nothing was sent again.",
    };
    return NextResponse.json(result);
  }

  // ── (3) THE REMINDER ─────────────────────────────────────────────────────
  // Everything from here is best effort against a register that is ALREADY
  // locked and mirrors that are ALREADY correct. No failure below may undo
  // either, and every early return is a 200 saying why no mail went.
  const done = (
    sent: number,
    skipped: number,
    reason: string | null,
    forced: boolean = false,
  ) =>
    NextResponse.json({
      ok: true,
      sessionKey: session.sessionKey,
      alreadyPushed,
      mirrored,
      sent,
      skipped,
      forced,
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

  // SCOPED TO THIS GROUP INSIDE the derivation, not filtered after it: the
  // recipient ceiling has to be counted on the group being mailed, or a large
  // run refuses every one of its groups' reminders while every register locks.
  const audience = await resolveCohortAudience(db, runId, LANE, { groupId });
  if (audience.refusal) return done(0, audience.skipped, audience.refusal);
  const recipients: CohortRecipient[] = audience.members;
  let skipped = audience.skipped;
  if (recipients.length === 0) {
    // Deliberately does NOT claim the marker: an audience that is empty today
    // (everyone opted out, nobody allocated yet) must not permanently suppress
    // this reminder for whoever becomes deliverable tomorrow.
    return done(0, skipped, "Nobody in this group is set up to receive email, so none was sent.");
  }

  // ── EVERYTHING THE MAIL NEEDS, RESOLVED BEFORE THE CLAIM ─────────────────
  // Read ABOVE the marker on purpose. Claiming first and then failing to read
  // the config or the template would burn the group's one claim on a send that
  // never happened, and the only recovery lane left would be the run-wide force
  // that mails every OTHER group a second time. After this point only the
  // transport itself can fail, and the per-group force below is that recovery.
  // (`config` is read further up, where the follow-up archive needs it. Same
  // property, one read. A read that FAILED is the one case this lane cannot
  // ride out: sending with default copy would silently drop the feedback link
  // and burn the group's one claim on it, so the send is refused instead. The
  // register is locked either way and the next push retries cleanly, because
  // nothing has been claimed.)
  if (!config) {
    return done(
      0,
      skipped,
      "The course settings couldn't be read, so no reminder was sent. Try the push again in a moment.",
    );
  }
  const template = await resolveCourseNudgeTemplate(db);

  // ── CLAIM THE MARKER, OUTSIDE THE TRANSACTION ────────────────────────────
  // Deterministic id plus `.create()` IS the guarantee. It lives in
  // `courseNudges`, already locked `read, write: if false` as server-side
  // course-email bookkeeping, so this ships with no rules change.
  const markerRef = db
    .collection("courseNudges")
    .doc(
      groupNudgeMarkerId(
        runId,
        groupId,
        nextSession.slotStartKey,
        nextSession.occurrence,
      ),
    );
  const stamp = Timestamp.fromDate(now);
  let forced = false;
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
    if (!force) {
      // Another push (or the admin catch-up) already claimed this group's
      // reminder for the next session. The register is still locked, which is
      // the point of doing this after the commit.
      return done(
        0,
        skipped,
        "This group has already had the reminder for its next session.",
      );
    }
    // ── THE PER-GROUP RESEND ───────────────────────────────────────────────
    // AUDIT FIRST, then send, exactly as the run-level catch-up does: a forced
    // re-send is on the record before a single message leaves, so a crash
    // mid-force still leaves evidence. The marker is UPDATED, never deleted:
    // the record of the first send survives the second, and `forces` grows by
    // one small map per force, bounded by the hourly push throttle above.
    //
    // This exists so a transport failure after the claim has a recovery that
    // touches THIS GROUP ONLY. Without it the sole lane was the run-wide force,
    // which mails every other group of the run a second time.
    forced = true;
    await markerRef.update({
      forceCount: FieldValue.increment(1),
      lastForcedAt: stamp,
      lastForcedByUid: actor.uid,
      forces: FieldValue.arrayUnion({
        uid: actor.uid,
        at: stamp,
        recipientCount: recipients.length,
        forcedOverMarkerId: markerRef.id,
      }),
    });
    console.warn(
      "[courses push] FORCED re-send of a claimed group reminder",
      runId,
      groupId,
      nextSession.sessionKey,
      actor.uid,
      recipients.length,
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const channel = courseRunChannel(runId);
  // `resolveSessions` already dated this session, from the group's OWN
  // calendar and with the week's override applied. Recomputing it from the
  // slot start and the standing weekday would be a second answer to a question
  // that already has one, and the two can legitimately differ.
  const sessionWhen = courseNudgeSessionWhen(nextSession.session, nextSession.dateKey);
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
    forced,
  });
  return done(sent, skipped, null, forced);
}
