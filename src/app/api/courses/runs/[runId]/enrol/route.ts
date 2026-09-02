import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { enrolWindow, isEnrolOpen } from "@/lib/courses/enrolWindow";
import { joinedWeekFor } from "@/lib/courses/groupResolve";
import { formatWindowDate, formatWindowDeadline } from "@/lib/courses/window";
import {
  fetchGroupPicker,
  type GroupPickerOption,
} from "@/features/courses/fetchGroupPicker";
import { COURSE_AUDIT_COLLECTION } from "@/lib/firestore/courseAudit";
import { readCoursesConfig } from "@/lib/firestore/config";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
  ENROLMENT_LIMITS,
  type CourseEnrolmentStatus,
} from "@/lib/firestore/courseEnrolments";
import {
  groupFullError,
  normalizeCourseGroup,
} from "@/lib/firestore/courseGroups";
import { courseTaskId, MIRRORED_TASK_SOURCE } from "@/lib/firestore/courseTasks";
import {
  courseRunChannel,
  normalizeCourseRun,
  type CourseRunDoc,
} from "@/lib/firestore/courses";
import { unsubscribe, subscribe } from "@/lib/firestore/subscriptions";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { sendCourseDroppedOutEmail } from "@/lib/email/courseEnrolmentEmails";
import {
  DEFAULT_PAUSED_MESSAGE,
  DEFAULT_SITE_NOTICE,
  SITE_NOTICE_PATH,
  isSurfacePaused,
  normaliseSiteNotice,
} from "@/lib/siteNotice";

/**
 * OPEN ENROLMENT: clicking into a pre-course session slot, and leaving again.
 *
 *   GET    — the session slots on offer plus the caller's own row (if any)
 *   POST   — take a seat in one of them
 *   PATCH  — move to a different session, or change stream
 *   DELETE — drop out. IRREVERSIBLE.
 *
 * ── WHY A ROUTE AND NOT A CLIENT-DIRECT WRITE ───────────────────────────────
 * `courseEnrolments` is `allow write: if false` and it stays that way. Three
 * of this route's invariants cannot be expressed in a rule at all: the group's
 * `memberCount` and the run's `enrolledCount` must move in the SAME
 * transaction as the row (a counter that drifts is a seat count that lies), the
 * capacity check has to read that counter transactionally so two people
 * clicking at once cannot both take the last place, and `joinedWeekNumber` is
 * resolved against the TARGET GROUP's calendar, which means reading a second
 * document.
 *
 * ── THE DETERMINISTIC ID IS THE WHOLE UNIQUENESS STORY ───────────────────────
 * One enrolment per (run, uid) exists structurally: `tx.create` at
 * `courseEnrolmentId(runId, uid)` throws ALREADY_EXISTS rather than minting a
 * second row, so nothing here queries "are they already on this run".
 *
 * A consequence worth stating out loud: because the row survives a drop-out,
 * SELF RE-ENROLMENT AFTER DROPPING OUT IS IMPOSSIBLE, and that is the decision
 * ("irreversible: it frees the seat and stops the nudges, and coming back is a
 * new enrolment rather than an undo"). Staff can still re-place someone
 * through the allocation board, which flips the same row back to active.
 *
 * ── WHO MAY ENROL ───────────────────────────────────────────────────────────
 * Any signed-in account EXCEPT a `rejected` one, `pending` included. That is
 * the same gate the apply route uses and it is deliberate: the pre-course
 * opens during Welcome Week, when every fresher who has just registered is
 * still `pending`. (Their access to /learn afterwards is a separate change,
 * which is why the confirmation copy here does not promise it.)
 *
 * ── RATE LIMITS BEFORE THE READS ────────────────────────────────────────────
 * The per-IP limit is taken before the session lookup, since it needs no
 * identity; the per-uid limit as soon as there is a uid, and both before this
 * route reads anything of its own. Throttling exists to cap COST, so it has to
 * come before the work it is protecting.
 */

type Ctx = { params: Promise<{ runId: string }> };

/** Abuse throttle (see lib/rateLimit): generous per shared campus NAT IP,
    tighter per account. Matched to the apply route's shape. */
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_IP_MAX = 60;
const RL_UID_MAX = 10;

/**
 * How many weeks back the drop-out sweep looks for this member's mirrored My
 * Work cards. The mirror is created lazily, one card per cohort week, so the
 * most a live run can have produced is one per week of its plan; 60 is
 * `weekDocId`'s own ceiling and therefore covers every run that can exist.
 */
const MAX_MIRROR_WEEKS = 60;

type Db = NonNullable<ReturnType<typeof getAdminDb>>;

class EnrolError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Shared preamble
// ---------------------------------------------------------------------------

type Caller = { user: SessionUser; db: Db };

/**
 * Signed in, not rejected, database available. `pending` passes: see the
 * module comment.
 */
async function requireEnroller(): Promise<Caller | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (user.role === "rejected") {
    return NextResponse.json(
      { error: "This account can't sign up for courses." },
      { status: 403 },
    );
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }
  return { user, db };
}

function tooManyAttempts(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Please wait a few minutes and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Server-side read of the maintenance notice, through the same shared
 * normaliser the banner and every client surface use, so a paused surface
 * reads identically wherever it is checked.
 *
 * FAIL-OPEN, matching `siteNotice.ts`'s load-bearing guarantee: an unreadable
 * or malformed doc degrades to "notice off". Refusing enrolments because the
 * notice doc could not be read would be an outage caused by the outage banner.
 */
async function readSiteNotice(db: Db) {
  try {
    const snap = await db
      .collection(SITE_NOTICE_PATH.collection)
      .doc(SITE_NOTICE_PATH.doc)
      .get();
    return normaliseSiteNotice(snap.exists ? snap.data() : null, new Date());
  } catch {
    return DEFAULT_SITE_NOTICE;
  }
}

async function loadRun(db: Db, runId: string): Promise<CourseRunDoc | null> {
  const snap = await db.collection("courseRuns").doc(runId).get();
  if (!snap.exists) return null;
  return normalizeCourseRun(snap.id, snap.data() ?? {});
}

/**
 * The sentence a member reads when a run is not taking sign-ups, or null when
 * it is. Derived from `enrolWindow()` so the copy and the refusal are the same
 * three lines of arithmetic that decide what the course page offers, which is
 * the disagreement `lib/courses/window.ts` was written to end.
 *
 * `inactive` deliberately gets the same sentence as `closed`: whether a run is
 * a draft, archived, or simply an admissions run is not a visitor's business.
 */
function windowError(run: CourseRunDoc, now: Date): string | null {
  const w = enrolWindow(run, now);
  if (w.state === "open") return null;
  if (w.state === "not-yet") {
    return w.opensAt
      ? `Sign-ups open on ${formatWindowDate(w.opensAt)}.`
      : "Sign-ups for this course haven't opened yet.";
  }
  return w.closesAt && w.state === "closed"
    ? `Sign-ups closed on ${formatWindowDeadline(w.closesAt)}.`
    : "This course isn't taking sign-ups.";
}

/**
 * Validate the requested stream against the run's declared list AND the target
 * group's own tag, and return the id to store.
 *
 * Both halves matter. The run's `streams` is what `courseEnrolments.streamId`
 * has to name for `streamScope.ts` to resolve a week's materials, and the
 * group's `streamId` is what says which stream that session actually teaches.
 * A member who picks "governance" and the technical session would otherwise
 * sit in a room working through material their row says they cannot see.
 */
function resolveStreamId(
  run: CourseRunDoc,
  groupStreamId: string | null,
  requested: unknown,
): { streamId: string | null } | { error: string } {
  const asked =
    typeof requested === "string" && requested ? requested : null;

  if (run.streams.length === 0) {
    // A run with no streams stores null, whatever was posted: there is
    // nothing for an id to name.
    return { streamId: null };
  }

  if (!asked) {
    return { error: "Pick which strand you'd like to join." };
  }
  if (!run.streams.some((s) => s.id === asked)) {
    return { error: "That strand isn't one of this course's options." };
  }
  if (groupStreamId !== null && groupStreamId !== asked) {
    const label = run.streams.find((s) => s.id === groupStreamId)?.label ?? "";
    return {
      error: label
        ? `That session is for the ${label} strand. Pick a session that runs your strand.`
        : "That session doesn't run the strand you picked.",
    };
  }
  return { streamId: asked };
}

// ---------------------------------------------------------------------------
// GET — what the picker renders
// ---------------------------------------------------------------------------

/**
 * The caller's own enrolment row, flattened. Deliberately four fields: this is
 * a public-page payload, and the row also carries an attendance rollup and a
 * drop-out reason that belong on the learning surfaces, not here.
 */
export type MyEnrolmentSummary = {
  groupId: string | null;
  streamId: string | null;
  status: CourseEnrolmentStatus;
  /** "facilitator" rows exist on the same doc id; the picker must not offer
      a facilitator a learner seat they already structurally cannot take. */
  role: "learner" | "facilitator";
};

export type EnrolStatePayload = {
  groups: GroupPickerOption[];
  enrolment: MyEnrolmentSummary | null;
};

/**
 * Refresh the picker: the slots (with current seat counts) plus the caller's
 * own row. A READ ONLY: nothing here writes, so it needs no view-as guard.
 *
 * It exists because `courseGroups` is not client-readable and the seat counts
 * move: after an enrol, a change or a drop, the client re-reads through here
 * rather than guessing at what its own action did to everyone else's numbers.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;

  const caller = await requireEnroller();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const [groups, snap] = await Promise.all([
    fetchGroupPicker(runId),
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, user.uid)).get(),
  ]);

  let enrolment: MyEnrolmentSummary | null = null;
  if (snap.exists) {
    const row = normalizeCourseEnrolment(snap.id, snap.data() ?? {});
    // Belt to the doc id's brace: a hand-made document at a guessable path
    // must not be reported as this caller's enrolment.
    if (row.uid === user.uid && row.runId === runId) {
      enrolment = {
        groupId: row.groupId,
        streamId: row.streamId,
        status: row.status,
        role: row.role,
      };
    }
  }

  const payload: EnrolStatePayload = { groups, enrolment };
  return NextResponse.json(payload);
}

// ---------------------------------------------------------------------------
// POST — take a seat
// ---------------------------------------------------------------------------

export async function POST(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId } = await ctx.params;

  // Per-IP first: it needs no identity, so it can sit in front of the session
  // lookup's Auth RPC and user-doc read.
  const ipLimit = rateLimit(
    `courses:enrol:ip:${clientIp(req)}`,
    RL_IP_MAX,
    RL_WINDOW_MS,
  );
  if (!ipLimit.ok) return tooManyAttempts(ipLimit.retryAfterSeconds);

  const caller = await requireEnroller();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidLimit = rateLimit(
    `courses:enrol:uid:${user.uid}`,
    RL_UID_MAX,
    RL_WINDOW_MS,
  );
  if (!uidLimit.ok) return tooManyAttempts(uidLimit.retryAfterSeconds);

  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const groupId = typeof body.groupId === "string" ? body.groupId : "";
  if (!groupId) {
    return NextResponse.json({ error: "Pick a session first." }, { status: 400 });
  }

  const run = await loadRun(db, runId);
  if (!run) {
    return NextResponse.json({ error: "Course run not found." }, { status: 404 });
  }
  const openError = windowError(run, new Date());
  if (openError) return NextResponse.json({ error: openError }, { status: 400 });

  // The pause gate applies to NEW sign-ups only. Someone already enrolled
  // keeps their place, their access, and their ability to change session or
  // leave, which is what the admin panel's copy for this flag promises.
  const notice = await readSiteNotice(db);
  if (isSurfacePaused(notice, "courseEnrolments")) {
    return NextResponse.json(
      { error: notice.bannerMessage || DEFAULT_PAUSED_MESSAGE },
      { status: 503 },
    );
  }

  const enrolmentRef = db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, user.uid));
  const runRef = db.collection("courseRuns").doc(runId);
  const groupRef = db.collection("courseGroups").doc(groupId);

  let streamId: string | null = null;

  try {
    await db.runTransaction(async (tx) => {
      // Reads first, all of them: Firestore forbids a read after the first
      // write in a transaction.
      const [runSnap, groupSnap, existingSnap] = await tx.getAll(
        runRef,
        groupRef,
        enrolmentRef,
      );

      // The run is re-read INSIDE the transaction, not trusted from the check
      // above: an admin could flip the run out of open mode, or an automated
      // status move could close it, between the two. The outside read is what
      // produces the good copy; this one is what makes the decision.
      if (!runSnap.exists) throw new EnrolError("Course run not found.", 404);
      const freshRun = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
      if (!isEnrolOpen(freshRun, new Date())) {
        throw new EnrolError(
          windowError(freshRun, new Date()) ?? "This course isn't taking sign-ups.",
          409,
        );
      }

      if (!groupSnap.exists) {
        throw new EnrolError("That session is no longer on offer.", 409);
      }
      const group = normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {});
      if (group.runId !== runId || group.archived) {
        throw new EnrolError("That session is no longer on offer.", 409);
      }

      const stream = resolveStreamId(freshRun, group.streamId, body.streamId);
      if ("error" in stream) throw new EnrolError(stream.error, 400);
      streamId = stream.streamId;

      if (existingSnap.exists) {
        const row = normalizeCourseEnrolment(existingSnap.id, existingSnap.data() ?? {});
        throw new EnrolError(
          row.status === "active"
            ? "You're already signed up for this course."
            : "You've already left this course, so you can't sign up again here. Email the team if you'd like to come back.",
          409,
        );
      }

      // CAPACITY, against the count read inside this transaction. Two people
      // taking the last seat at once: one transaction sees memberCount one
      // below capacity and commits, the other retries, re-reads the committed
      // count, and is refused here. Same predicate the picker greys the card
      // out with, so the two agree.
      const full = groupFullError({
        name: group.name,
        capacity: group.capacity,
        memberCount: group.memberCount,
      });
      if (full) throw new EnrolError(full, 409);

      tx.create(enrolmentRef, {
        runId,
        courseId: freshRun.courseId,
        uid: user.uid,
        groupId,
        status: "active" satisfies CourseEnrolmentStatus,
        role: "learner",
        streamId,
        // Not an application, and not an admin placing them either — see
        // `selfEnrolled` on `CourseEnrolmentDoc`.
        selfEnrolled: true,
        applicationId: null,
        // THEIR group's clock, not the run's. Shared with the allocation
        // route so the two writers of a fresh enrolment cannot disagree.
        joinedWeekNumber: joinedWeekFor(freshRun, group),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(groupRef, {
        memberCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(runRef, {
        enrolledCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof EnrolError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Lost the create race with a second tab.
    if ((err as { code?: number }).code === 6) {
      return NextResponse.json(
        { error: "You're already signed up for this course." },
        { status: 409 },
      );
    }
    console.error("[courses enrol] transaction failed", runId, user.uid, err);
    return NextResponse.json(
      { error: "Couldn't sign you up just now. Please try again." },
      { status: 500 },
    );
  }

  // Post-commit and best-effort, exactly as allocation publish does it: the
  // seat is taken either way, and a bookkeeping failure must not turn a
  // successful sign-up into an error the member sees. `inboxProven` because
  // this is the account's own sign-in address.
  await subscribeToCohort(db, runId, user);

  // NO AUDIT ROW ON THE WAY IN, deliberately: `CourseAuditKind` has no "enrol"
  // member, and inventing one would put a string in the log that
  // `courseAuditKindLabel` renders as "Unrecognised action". The enrolment
  // document IS the record of joining (it carries `selfEnrolled`, `createdAt`
  // and the group). Leaving is different — it destroys state, so it gets a row.

  return NextResponse.json({ ok: true, groupId, streamId });
}

/**
 * Join the run's cohort channel so the weekly emails reach them. Failure is
 * logged and swallowed: `subscribe()` writes a (email, channel) row that the
 * member can fix from their own profile, and no part of the enrolment depends
 * on it.
 */
async function subscribeToCohort(db: Db, runId: string, user: SessionUser) {
  if (!user.email) return;
  try {
    await subscribe(db, {
      email: user.email,
      channel: courseRunChannel(runId),
      audience: "user",
      audienceId: user.uid,
      source: "course-open-enrol",
      actor: {
        kind: "member",
        uid: user.uid,
        label: user.displayName?.trim() || "NAISI member",
      },
      inboxProven: true,
      name: user.displayName?.trim() || undefined,
    });
  } catch (err) {
    console.warn("[courses enrol] cohort subscribe failed", runId, user.uid, err);
  }
}

// ---------------------------------------------------------------------------
// PATCH — change session or stream
// ---------------------------------------------------------------------------

/**
 * Move to a different session, change stream, or both.
 *
 * TWO COUNTER DELTAS, ONE TRANSACTION: the old group loses a seat and the new
 * one gains it atomically with the row's `groupId`, or nothing happens. The
 * run's `enrolledCount` does NOT move — the member is still on the run.
 *
 * Not gated on the maintenance pause: pausing enrolment means "no new
 * sign-ups", and someone already holding a seat swapping Tuesday for Thursday
 * is not a new sign-up.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId } = await ctx.params;

  const ipLimit = rateLimit(
    `courses:enrol:ip:${clientIp(req)}`,
    RL_IP_MAX,
    RL_WINDOW_MS,
  );
  if (!ipLimit.ok) return tooManyAttempts(ipLimit.retryAfterSeconds);

  const caller = await requireEnroller();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidLimit = rateLimit(
    `courses:enrol:uid:${user.uid}`,
    RL_UID_MAX,
    RL_WINDOW_MS,
  );
  if (!uidLimit.ok) return tooManyAttempts(uidLimit.retryAfterSeconds);

  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const groupId = typeof body.groupId === "string" ? body.groupId : "";
  if (!groupId) {
    return NextResponse.json({ error: "Pick a session first." }, { status: 400 });
  }

  const run = await loadRun(db, runId);
  if (!run) {
    return NextResponse.json({ error: "Course run not found." }, { status: 404 });
  }
  const openError = windowError(run, new Date());
  if (openError) return NextResponse.json({ error: openError }, { status: 400 });

  const enrolmentRef = db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, user.uid));
  const targetRef = db.collection("courseGroups").doc(groupId);

  let streamId: string | null = null;

  try {
    await db.runTransaction(async (tx) => {
      const [runSnap, targetSnap, existingSnap] = await tx.getAll(
        db.collection("courseRuns").doc(runId),
        targetRef,
        enrolmentRef,
      );

      if (!runSnap.exists) throw new EnrolError("Course run not found.", 404);
      const freshRun = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
      if (!isEnrolOpen(freshRun, new Date())) {
        throw new EnrolError(
          "This course isn't taking session changes any more.",
          409,
        );
      }

      if (!existingSnap.exists) {
        throw new EnrolError("You're not signed up for this course.", 404);
      }
      const row = normalizeCourseEnrolment(existingSnap.id, existingSnap.data() ?? {});
      if (row.uid !== user.uid || row.runId !== runId) {
        throw new EnrolError("You're not signed up for this course.", 404);
      }
      if (row.role !== "learner") {
        throw new EnrolError(
          "You're on this course as a facilitator. Ask an admin to change which group you run.",
          409,
        );
      }
      if (row.status !== "active") {
        throw new EnrolError(
          "You're not on this course any more, so there's no session to change.",
          409,
        );
      }

      if (!targetSnap.exists) {
        throw new EnrolError("That session is no longer on offer.", 409);
      }
      const target = normalizeCourseGroup(targetSnap.id, targetSnap.data() ?? {});
      if (target.runId !== runId || target.archived) {
        throw new EnrolError("That session is no longer on offer.", 409);
      }

      const stream = resolveStreamId(freshRun, target.streamId, body.streamId);
      if ("error" in stream) throw new EnrolError(stream.error, 400);
      streamId = stream.streamId;

      const movingGroup = row.groupId !== groupId;

      // Capacity is only asked when the seat is actually new. Re-saving the
      // same session to change stream must not be refused by the group the
      // member is already counted in.
      if (movingGroup) {
        const full = groupFullError({
          name: target.name,
          capacity: target.capacity,
          memberCount: target.memberCount,
        });
        if (full) throw new EnrolError(full, 409);
      }

      const patch: Record<string, unknown> = {
        groupId,
        streamId,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (movingGroup) {
        // The stamp certifies "emailed about their CURRENT group"; a changed
        // session invalidates it, exactly as it does on the allocate route.
        patch.allocatedEmailAt = FieldValue.delete();
      }
      tx.update(enrolmentRef, patch);

      if (movingGroup) {
        if (row.groupId) {
          tx.update(db.collection("courseGroups").doc(row.groupId), {
            memberCount: FieldValue.increment(-1),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        tx.update(targetRef, {
          memberCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (err) {
    if (err instanceof EnrolError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses enrol] change failed", runId, user.uid, err);
    return NextResponse.json(
      { error: "Couldn't change your session just now. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, groupId, streamId });
}

// ---------------------------------------------------------------------------
// DELETE — drop out
// ---------------------------------------------------------------------------

/**
 * Leave the course. IRREVERSIBLE, by decision: the seat is freed, the nudges
 * stop, and coming back is a new enrolment somebody else has to make.
 *
 * Behind a TYPED CONFIRMATION of the course title, the same ritual the destroy
 * routes use and for the same reason: this is the one member-facing action on
 * the courses surface that cannot be undone by the person taking it, and a
 * mis-tapped button on a phone must not be able to do it.
 *
 * OPEN-MODE RUNS ONLY. A seat that came out of admissions has a
 * `courseApplications` row behind it that would still read "accepted" after
 * the enrolment went away, which leaves the allocation board holding a
 * placeless accepted applicant and blocks allocation publish. Reconciling the
 * two is real work with no owner yet, so the route refuses rather than
 * offering a repair it cannot perform: an admissions cohort member asks staff,
 * who use the remove route.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId } = await ctx.params;

  const ipLimit = rateLimit(
    `courses:enrol:ip:${clientIp(req)}`,
    RL_IP_MAX,
    RL_WINDOW_MS,
  );
  if (!ipLimit.ok) return tooManyAttempts(ipLimit.retryAfterSeconds);

  const caller = await requireEnroller();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidLimit = rateLimit(
    `courses:enrol:uid:${user.uid}`,
    RL_UID_MAX,
    RL_WINDOW_MS,
  );
  if (!uidLimit.ok) return tooManyAttempts(uidLimit.retryAfterSeconds);

  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const run = await loadRun(db, runId);
  if (!run) {
    return NextResponse.json({ error: "Course run not found." }, { status: 404 });
  }
  if (run.enrolMode !== "open") {
    return NextResponse.json(
      {
        error:
          "Leaving this course isn't something you can do yourself. Email the team and we'll sort it out with you.",
      },
      { status: 409 },
    );
  }

  // An unnamed course cannot be confirmed by name: with an empty title the
  // comparison is "" === "" and the ritual passes on an empty body. The
  // destroy routes refuse for the same reason, and so does this one.
  if (run.courseTitle.length === 0) {
    return NextResponse.json(
      {
        error:
          "This course has no title yet, so there's nothing to type as confirmation. Email the team and we'll take you off it.",
      },
      { status: 409 },
    );
  }
  // Byte equality against the course TITLE — nothing normalised away.
  if (body.confirmName !== run.courseTitle) {
    return NextResponse.json(
      { error: "That doesn't match the course title. Type it exactly to confirm." },
      { status: 400 },
    );
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, ENROLMENT_LIMITS.dropOutReason)
      : null;

  const enrolmentRef = db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, user.uid));

  let leftGroupId: string | null = null;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(enrolmentRef);
      if (!snap.exists) {
        throw new EnrolError("You're not signed up for this course.", 404);
      }
      const row = normalizeCourseEnrolment(snap.id, snap.data() ?? {});
      if (row.uid !== user.uid || row.runId !== runId) {
        throw new EnrolError("You're not signed up for this course.", 404);
      }
      if (row.role !== "learner") {
        throw new EnrolError(
          "You're on this course as a facilitator. Ask an admin to stand you down.",
          409,
        );
      }
      // Idempotent: a double-tapped confirm must not decrement a counter
      // twice, and must not read as a failure to the member.
      if (row.status === "withdrawn") return;
      if (row.status !== "active") {
        throw new EnrolError("You're not on this course any more.", 409);
      }

      leftGroupId = row.groupId;

      tx.update(enrolmentRef, {
        status: "withdrawn" satisfies CourseEnrolmentStatus,
        droppedOutAt: FieldValue.serverTimestamp(),
        // Stored as a real null rather than omitted, so a later drop-out
        // form that collects nothing overwrites an earlier value rather
        // than leaving a stale sentence attached to the row.
        dropOutReason: reason,
        // The stamp certifies "emailed about their current group"; there is
        // no current placement any more.
        allocatedEmailAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // `groupId` is KEPT. `memberCount` counts enrolments that are both
      // active AND grouped (the allocate route's definition), so a withdrawn
      // row holds no seat whatever its `groupId` says, and keeping it is what
      // lets a facilitator see which of their sessions someone left.
      if (row.groupId) {
        tx.update(db.collection("courseGroups").doc(row.groupId), {
          memberCount: FieldValue.increment(-1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(db.collection("courseRuns").doc(runId), {
        enrolledCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof EnrolError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses enrol] drop-out failed", runId, user.uid, err);
    return NextResponse.json(
      { error: "Couldn't take you off the course just now. Please try again." },
      { status: 500 },
    );
  }

  const config = await readCoursesConfig(db).catch(() => null);
  const feedbackUrl = config?.dropOutFeedbackUrl ?? "";

  // ── Everything after the commit is best effort ────────────────────────────
  // The member has left; none of the tidying below may turn that into an
  // error they see. Each step logs its own failure.

  // The audit row goes AFTER the commit, and that is a deliberate departure
  // from the enrol-mode route's audit-first ordering. There the actor is an
  // admin and a spare row is harmless; here a row saying a member left when
  // they did not would send a facilitator chasing somebody who is still in
  // the room. The enrolment document is itself a durable record (status,
  // `droppedOutAt`, `dropOutReason`), so this row is the searchable index of
  // the event rather than its only trace.
  try {
    await db.collection(COURSE_AUDIT_COLLECTION).add({
      kind: "enrolment-dropout",
      runId,
      groupId: leftGroupId,
      subjectUid: user.uid,
      actorUid: user.uid,
      actorName: user.displayName ?? "",
      targetLabel: run.label || runId,
      detail: reason
        ? `Left the course. Reason given: ${reason}`
        : "Left the course. No reason given.",
      at: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[courses enrol] drop-out audit row failed", runId, user.uid, err);
  }

  await unsubscribeFromCohort(db, runId, user);
  await deleteMirroredTasks(db, run, user.uid);

  if (user.email) {
    // Fire and forget, the RSVP-submit pattern: the member must not wait on
    // SMTP to see their own confirmation.
    void sendCourseDroppedOutEmail({
      to: user.email,
      name: user.displayName?.trim() || "NAISI member",
      courseTitle: run.courseTitle,
      runLabel: run.label,
      feedbackUrl,
      uid: user.uid,
      runId,
    }).catch((err) => {
      console.error("[courses enrol] drop-out email failed", runId, user.uid, err);
    });
  }

  return NextResponse.json({ ok: true, feedbackUrl });
}

/** Stop the cohort mail. Non-fatal: the row may not even exist. */
async function unsubscribeFromCohort(db: Db, runId: string, user: SessionUser) {
  if (!user.email) return;
  try {
    await unsubscribe(db, {
      email: user.email,
      channel: courseRunChannel(runId),
      actor: {
        kind: "member",
        uid: user.uid,
        label: user.displayName?.trim() || "NAISI member",
      },
    });
  } catch (err) {
    console.warn("[courses enrol] cohort unsubscribe failed", runId, user.uid, err);
  }
}

/**
 * Clear this member's mirrored My Work cards for the run they just left.
 *
 * ADDRESSED BY DETERMINISTIC ID, never by query. `courseTaskId(runId, week,
 * uid)` names every card the mirror can have created, one per cohort week, so
 * the sweep is a bounded `getAll` over the run's own week plan rather than a
 * three-filter query that would need a composite index on `tasks`.
 *
 * Each candidate is VERIFIED before it is deleted: the doc must carry the
 * mirror's `source` (which the tasks rules pin, so no client can claim it) and
 * list this member as a completer. A deterministic id is a guessable id, and
 * without that check a squatter's task at the same path would be deleted by
 * somebody else's drop-out.
 *
 * `recursiveDelete` rather than a plain delete: a mirror behaves like a
 * personal task, so it can carry comments and activity, and a parent-doc
 * delete leaves subcollections behind.
 */
async function deleteMirroredTasks(db: Db, run: CourseRunDoc, uid: string) {
  try {
    const weekCount = Math.min(
      MAX_MIRROR_WEEKS,
      run.weekPlan.filter((e) => e.kind === "week").length,
    );
    if (weekCount === 0) return;
    const refs = Array.from({ length: weekCount }, (_, i) =>
      db.collection("tasks").doc(courseTaskId(run.id, i + 1, uid)),
    );
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() ?? {};
      const isOurMirror =
        data.source === MIRRORED_TASK_SOURCE &&
        Array.isArray(data.completerUids) &&
        (data.completerUids as unknown[]).includes(uid);
      if (!isOurMirror) continue;
      await db.recursiveDelete(snap.ref);
    }
  } catch (err) {
    console.warn("[courses enrol] mirrored task cleanup failed", run.id, uid, err);
  }
}
