import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  type CourseEnrolmentStatus,
} from "@/lib/firestore/courseEnrolments";
import { courseApplicationId } from "@/lib/firestore/courseApplications";
import { courseRunChannel, normalizeCourseRun } from "@/lib/firestore/courses";
import { unsubscribe } from "@/lib/firestore/subscriptions";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * Remove one learner from a run: their enrolment flips to `status:"removed"`
 * and its `groupId` clears, releasing the seat, in one transaction with the
 * group's `memberCount` decrement.
 *
 * WHO MAY REMOVE: admins ∪ the run's `trackLeadUids` — the allocation gate.
 *
 * A SOFT removal, deliberately: the enrolment doc survives. The deterministic
 * doc id (`courseEnrolments/{runId}__{uid}`) is the one-enrolment-per-(run,
 * uid) invariant, so the row is that person's entire history on the run:
 * deleting it would let a later re-placement mint a "fresh" enrolment with no
 * memory. Re-admission is the allocate route flipping this same row back to
 * "active" (which also re-clears/re-earns the placement-email stamp via the
 * cleared `groupId`). That route needs an accepted application, so a member
 * who signed themselves up comes back through the reinstate route instead.
 *
 * FACILITATOR ROWS ARE OUT OF SCOPE: a `role:"facilitator"` enrolment is
 * managed by the group facilitators route (which retires it when the person
 * is unassigned). Refused here so the board can't quietly strip someone's
 * facilitator access under the guise of un-placing a learner.
 */

type Ctx = { params: Promise<{ runId: string; uid: string }> };

class RemoveError extends Error {
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

  const enrolmentRef = db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, uid));

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(enrolmentRef);
      if (!snap.exists) throw new RemoveError("Enrolment not found", 404);
      const existing = snap.data() ?? {};

      // The doc id is built from (runId, uid); a mismatch means a hand-made
      // doc. Fail closed rather than remove the wrong person.
      if (existing.uid !== uid || existing.runId !== runId) {
        throw new RemoveError("Enrolment not found", 404);
      }

      if (existing.role === "facilitator") {
        throw new RemoveError(
          "That's a facilitator enrolment — unassign them in the group editor instead.",
          409,
        );
      }

      const status = existing.status as CourseEnrolmentStatus;
      // Idempotent: a double-clicked Remove shouldn't surface a failure, and
      // must not decrement the counter twice.
      if (status === "removed") return;

      const groupId =
        typeof existing.groupId === "string" && existing.groupId
          ? existing.groupId
          : null;
      // `memberCount` counts enrolments that are both active AND grouped
      // (the allocate route's definition), so only that state releases a
      // seat: a withdrawn row's seat was already released when it left
      // "active".
      const heldSeat = status === "active" && groupId !== null;
      // `courseRuns.enrolledCount` is the OTHER counter, and it counts a
      // narrower set: active AND self-enrolled, whatever group they are in
      // (see the field's doc comment on `CourseRunDoc`). Removing somebody
      // who signed themselves up has to give it back, or a run whose whole
      // open-enrolled cohort was removed still reads as populated and the
      // enrol-mode route refuses to reopen it. An allocated learner was
      // never counted by it, so removing one moves nothing.
      const heldOpenSeat = status === "active" && existing.selfEnrolled === true;

      tx.update(enrolmentRef, {
        status: "removed" satisfies CourseEnrolmentStatus,
        groupId: null,
        // The stamp certifies "emailed about their current group"; there is
        // no current group any more, and a future re-placement must earn a
        // fresh placement email on the next publish.
        allocatedEmailAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (heldSeat && groupId) {
        tx.update(db.collection("courseGroups").doc(groupId), {
          memberCount: FieldValue.increment(-1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (heldOpenSeat) {
        tx.update(db.collection("courseRuns").doc(runId), {
          enrolledCount: FieldValue.increment(-1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (err) {
    if (err instanceof RemoveError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses remove] transaction failed", runId, uid, err);
    return NextResponse.json({ error: "Couldn't remove that enrolment." }, { status: 500 });
  }

  // Post-commit, best-effort: drop them from the cohort channel so run
  // announcements stop. Failure is acceptable degradation — the removal
  // itself has committed, and `unsubscribe()` flips a (email, channel) row
  // that may not even exist yet if allocation was never published.
  try {
    const userSnap = await db.collection("users").doc(uid).get();
    let email =
      userSnap.exists && typeof userSnap.data()?.email === "string"
        ? (userSnap.data()?.email as string)
        : "";
    if (!email) {
      // Deleted account: fall back to the address captured at apply time,
      // which is the one the publish route would have subscribed.
      const appSnap = await db
        .collection("courseApplications")
        .doc(courseApplicationId(runId, uid))
        .get();
      const appEmail = appSnap.exists ? appSnap.data()?.email : null;
      email = typeof appEmail === "string" ? appEmail : "";
    }
    if (email) {
      await unsubscribe(db, {
        email,
        channel: courseRunChannel(runId),
        actor: {
          kind: isAdmin ? "admin" : "member",
          uid: actor.uid,
          label:
            actor.displayName?.trim() || (isAdmin ? "Admin" : "Track lead"),
        },
      });
    }
  } catch (err) {
    console.warn("[courses remove] cohort unsubscribe failed", runId, uid, err);
  }

  return NextResponse.json({ ok: true });
}
