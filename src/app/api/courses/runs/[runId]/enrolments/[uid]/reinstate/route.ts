import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
  type CourseEnrolmentStatus,
} from "@/lib/firestore/courseEnrolments";
import {
  groupFullError,
  normalizeCourseGroup,
} from "@/lib/firestore/courseGroups";
import { courseRunChannel, normalizeCourseRun } from "@/lib/firestore/courses";
import { subscribe } from "@/lib/firestore/subscriptions";

/**
 * Put a member who left an open-enrolment run back on it: their `withdrawn`
 * row flips to `active` and the two counters it was holding go back up, in
 * one transaction.
 *
 * WHO MAY REINSTATE: admins and the run's `trackLeadUids`, the same gate the
 * remove route uses. Reinstating is the exact inverse of removing, so it
 * belongs to the same people.
 *
 * ## Why this route had to exist
 *
 * The drop-out copy tells a member "the team can put you back on", and the
 * enrol route's own comment used to say staff do that through the allocation
 * board. They cannot: `allocate` refuses any uid whose `courseApplications`
 * row is not `accepted` (the `not-accepted` rejection), and a self-enrolled
 * member never had an application at all. So the one repair the member was
 * pointed at was the one repair the codebase could not perform.
 *
 * ## What it will not do
 *
 * SELF-ENROLLED, WITHDRAWN ROWS ONLY, and their own group.
 *
 *  - A `removed` row is staff's own decision, made on the board, and undone
 *    there: for an admissions learner that is the allocate route, which knows
 *    how to re-place them against their accepted application.
 *  - An allocated learner's row (`selfEnrolled` false) is not this route's
 *    business either, for the same reason and because `enrolledCount` never
 *    counted them, so re-incrementing it here would inflate a number the
 *    enrol-mode route reads.
 *  - The seat comes back in the session they left, which the withdrawn row
 *    still names (the drop keeps `groupId` precisely so a facilitator can see
 *    who left their session). Moving them somewhere else afterwards is the
 *    member's own "change session", or the allocation board's job.
 *
 * CAPACITY IS HARD. Somebody else may well have taken the seat in the
 * meantime, and quietly putting a 13th person in a room of 12 is how a
 * register hits `ATTENDANCE_LIMITS.maxRecords` and fails a bulk mark for the
 * whole group. The refusal names the group and is a sentence.
 *
 * NO AUDIT ROW, deliberately, and for the reason the enrol route gives for
 * joining: `CourseAuditKind` has no member for reinstatement, and inventing a
 * string would land in the log as "Unrecognised action". The enrolment
 * document carries the change (status, cleared drop-out stamp, `updatedAt`),
 * and the `enrolment-dropout` row it reverses is still in the log.
 */

type Ctx = { params: Promise<{ runId: string; uid: string }> };

class ReinstateError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function POST(_req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId, uid } = await ctx.params;
  if (!runId || !uid) {
    return NextResponse.json({ error: "Enrolment not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const isAdmin = actor.role === "admin";
  const isTrackLead = run.trackLeadUids.includes(actor.uid);
  if (!isAdmin && !isTrackLead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // A run being taken apart owns its own document until it is gone, and an
  // archived run is a withdrawn one. Adding somebody back to either is a seat
  // on a course that is not running.
  if ((runSnap.data() ?? {}).destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed, so nobody can be put back on it." },
      { status: 409 },
    );
  }
  if (run.archived) {
    return NextResponse.json(
      { error: "This run is archived. Unarchive it before putting anybody back on." },
      { status: 409 },
    );
  }

  const enrolmentRef = db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, uid));

  let groupId: string | null = null;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(enrolmentRef);
      if (!snap.exists) throw new ReinstateError("Enrolment not found", 404);
      const row = normalizeCourseEnrolment(snap.id, snap.data() ?? {});

      // The doc id is built from (runId, uid); a mismatch means a hand-made
      // doc. Fail closed rather than reinstate the wrong person.
      if (row.uid !== uid || row.runId !== runId) {
        throw new ReinstateError("Enrolment not found", 404);
      }

      // Idempotent: a double-clicked button is not an error, and must not
      // spend a second seat.
      if (row.status === "active") return;

      if (row.status !== "withdrawn") {
        throw new ReinstateError(
          "This place wasn't given up by the member, so it isn't this button's to give back. Use the allocation board.",
          409,
        );
      }
      if (!row.selfEnrolled) {
        throw new ReinstateError(
          "This member was placed by admissions rather than signing themselves up. Re-place them on the allocation board.",
          409,
        );
      }
      if (row.role !== "learner") {
        throw new ReinstateError(
          "That's a facilitator enrolment. Reassign them in the group editor instead.",
          409,
        );
      }
      if (!row.groupId) {
        throw new ReinstateError(
          "This enrolment has no session to go back to. Place them on the allocation board instead.",
          409,
        );
      }

      const groupRef = db.collection("courseGroups").doc(row.groupId);
      const groupSnap = await tx.get(groupRef);
      if (!groupSnap.exists) {
        throw new ReinstateError(
          "The session they were in has gone. Place them on the allocation board instead.",
          409,
        );
      }
      const group = normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {});
      if (group.runId !== runId || group.archived) {
        throw new ReinstateError(
          "The session they were in isn't running any more. Place them on the allocation board instead.",
          409,
        );
      }

      // Read INSIDE the transaction, like the enrol route's own capacity
      // check, so two people being put back into the last seat at once cannot
      // both get it.
      const full = groupFullError({
        name: group.name,
        capacity: group.capacity,
        memberCount: group.memberCount,
      });
      if (full) throw new ReinstateError(full, 409);

      groupId = row.groupId;

      tx.update(enrolmentRef, {
        status: "active" satisfies CourseEnrolmentStatus,
        // Cleared, both of them: a drop-out stamp on an active row reads as
        // current state to every later reader. The leaving is still in the
        // `courseAudit` log, where history belongs.
        droppedOutAt: null,
        dropOutReason: null,
        // The stamp certifies "emailed about their current group"; they have
        // not been emailed about this placement since it came back, so the
        // next publish earns it again.
        allocatedEmailAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(groupRef, {
        memberCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // Safe to move unconditionally here in a way the drop-out's decrement is
      // not: this route reinstates `selfEnrolled` rows and nothing else, which
      // is exactly what `enrolledCount` counts.
      tx.update(db.collection("courseRuns").doc(runId), {
        enrolledCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof ReinstateError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses reinstate] transaction failed", runId, uid, err);
    return NextResponse.json(
      { error: "Couldn't put them back on the course." },
      { status: 500 },
    );
  }

  // Post-commit and best effort, the enrol route's pattern: the place is
  // theirs either way, and the cohort channel is a row the member can fix
  // from their own profile. The drop-out unsubscribed them, so without this
  // a reinstated member would sit on the run hearing nothing.
  //
  // `inboxProven` on a staff-made call, the allocation publish route's
  // precedent and its reasoning: the address is the account's own sign-in
  // address, which is the "signed-in user's verified email" case subscribe()
  // documents, so this does not put a confirmation click between a member and
  // the cohort mail somebody has just put them back in.
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    const email = userSnap.exists ? userSnap.data()?.email : null;
    const name = userSnap.exists ? userSnap.data()?.displayName : null;
    if (typeof email === "string" && email) {
      await subscribe(db, {
        email,
        channel: courseRunChannel(runId),
        audience: "user",
        audienceId: uid,
        source: "course-reinstated",
        actor: {
          kind: isAdmin ? "admin" : "member",
          uid: actor.uid,
          label: actor.displayName?.trim() || (isAdmin ? "Admin" : "Track lead"),
        },
        inboxProven: true,
        name: typeof name === "string" && name ? name : undefined,
      });
    }
  } catch (err) {
    console.warn("[courses reinstate] cohort subscribe failed", runId, uid, err);
  }

  return NextResponse.json({ ok: true, groupId });
}
