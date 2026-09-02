import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  COURSE_ENROL_MODES,
  COURSE_ENROL_MODE_LABEL,
  type CourseEnrolMode,
} from "@/lib/firestore/courses";
import { COURSE_AUDIT_COLLECTION } from "@/lib/firestore/courseAudit";
import { groupCapacityError } from "@/lib/firestore/courseGroups";

/**
 * Move a run between `admissions` (apply, be reviewed, be allocated) and
 * `open` (everyone who signs up gets a place). The ONLY writer of
 * `courseRuns.enrolMode`; the rules birth-pin the field to "admissions" and
 * pin it unchanged on every client-direct update.
 *
 * ADMIN ONLY, and deliberately a tighter gate than the status route's
 * "admin or approveCourse". Opening a run changes what the enrol route will
 * ACCEPT: it admits an enrolment with no application behind it, which is a
 * write door rather than a lifecycle step. Approving curriculum and opening a
 * door are different powers, and the second one belongs to the smaller set.
 *
 * REFUSES ONCE ANYBODY IS ON THE RUN, in either direction, and that refusal
 * is the whole safety story:
 *
 *  - open -> admissions with people already self-enrolled would leave a
 *    cohort of enrolments with no application rows, on a run whose every
 *    admissions surface (the queue, the allocation board, the decide route)
 *    reads applications. Those members would be invisible to staff while
 *    still receiving the cohort's mail.
 *  - admissions -> open with applications pending would leave real people
 *    waiting on a decision from a review process the run no longer has, and
 *    the pending counter would never be decremented by anything.
 *
 * There is no reconciliation for either, so the route refuses rather than
 * offering a repair it cannot perform. An admin who genuinely needs to
 * change a populated run's mode removes the enrolments (or decides the
 * applications) first, which is exactly the accounting the refusal is asking
 * for.
 *
 * IT ALSO REFUSES TO OPEN A RUN WHOSE GROUPS ARE NOT CAPPED, and that check
 * is not tidiness. `groupCapacityOk()` in firestore.rules requires a
 * capacity in [1, 40] on every group whose parent run is `open`, and it is
 * evaluated against the MERGED document on an update, so a group that was
 * legal while the run was in admissions mode becomes unwritable the instant
 * the run flips: the facilitator who tries to move the room gets a raw
 * permission-denied, with nothing on the group or the run to explain it.
 * Flipping the run is the one write that can wedge a document it does not
 * touch, so it is the one write that has to look first.
 *
 * Every accepted change writes a `courseAudit` row before it returns: the
 * field is invisible on most surfaces and a silent flip is how a run ends up
 * in a mode nobody remembers choosing.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { enrolMode?: unknown };
  try {
    body = (await req.json()) as { enrolMode?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requested = body.enrolMode;
  if (!COURSE_ENROL_MODES.includes(requested as CourseEnrolMode)) {
    return NextResponse.json({ error: "Unknown enrolment mode" }, { status: 400 });
  }
  const nextMode = requested as CourseEnrolMode;

  const ref = db.collection("courseRuns").doc(runId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const data = snap.data() ?? {};

  // A run mid-destroy owns its own document until it is gone, the same 409
  // the status and archive routes give, for the same reason.
  if (data.destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed and its enrolment mode can't be changed." },
      { status: 409 },
    );
  }

  const currentMode = COURSE_ENROL_MODES.includes(data.enrolMode as CourseEnrolMode)
    ? (data.enrolMode as CourseEnrolMode)
    : "admissions";

  // Idempotent, like the status route: a double-clicked switch is not an
  // error, and re-sending the current mode must not write an audit row
  // claiming something changed.
  if (currentMode === nextMode) {
    return NextResponse.json({ ok: true, enrolMode: currentMode });
  }

  const enrolledCount =
    typeof data.enrolledCount === "number" && Number.isFinite(data.enrolledCount)
      ? Math.max(0, Math.floor(data.enrolledCount))
      : 0;
  const counts = (data.applicationCounts ?? {}) as Record<string, unknown>;
  const pending =
    typeof counts.pending === "number" && Number.isFinite(counts.pending)
      ? Math.max(0, Math.floor(counts.pending))
      : 0;

  if (enrolledCount > 0) {
    return NextResponse.json(
      {
        error: `This run already has ${enrolledCount} ${
          enrolledCount === 1 ? "person" : "people"
        } enrolled, so its enrolment mode is fixed. Remove the enrolments first if the run really has to change.`,
      },
      { status: 409 },
    );
  }
  if (pending > 0) {
    return NextResponse.json(
      {
        error: `This run has ${pending} application${
          pending === 1 ? "" : "s"
        } still awaiting a decision. Decide or withdraw them before changing how people get on to the run.`,
      },
      { status: 409 },
    );
  }

  // The groups have to be able to survive the flip. Checked BEFORE the audit
  // row and before the write, because the whole point is that the run never
  // reaches a state where its own groups are unwritable. `groupCapacityError`
  // is the same function the group routes and the group editor call, so the
  // admin reading this 409 and the facilitator reading the editor's inline
  // error are reading one sentence, written once.
  if (nextMode === "open") {
    const groups = await db
      .collection("courseGroups")
      .where("runId", "==", runId)
      .get();
    // Archived groups count too: the rule pins the merged document on EVERY
    // group write, and an archived group is still edited (unarchived, renamed,
    // re-roomed) rather than being read-only.
    const blocked: string[] = [];
    for (const g of groups.docs) {
      const raw = g.data() ?? {};
      const capacity =
        typeof raw.capacity === "number" && Number.isFinite(raw.capacity)
          ? raw.capacity
          : null;
      if (groupCapacityError(capacity, "open") !== null) {
        blocked.push(typeof raw.name === "string" && raw.name ? raw.name : g.id);
      }
    }
    if (blocked.length > 0) {
      const named = blocked.slice(0, 5).join(", ");
      const rest = blocked.length > 5 ? ` and ${blocked.length - 5} more` : "";
      return NextResponse.json(
        {
          error: `${groupCapacityError(null, "open")} Set one on ${named}${rest} before opening this run.`,
          groups: blocked,
        },
        { status: 409 },
      );
    }
  }

  // Audit BEFORE the change, the impersonations pattern: a row written after
  // a write that then fails is a lie, and a row written before one that fails
  // is a harmless extra line in a log.
  await db.collection(COURSE_AUDIT_COLLECTION).add({
    kind: "enrol-mode-change",
    runId,
    groupId: null,
    subjectUid: null,
    actorUid: actor.uid,
    actorName: actor.displayName ?? "",
    targetLabel: typeof data.label === "string" ? data.label : runId,
    detail: `Enrolment mode changed from ${COURSE_ENROL_MODE_LABEL[currentMode]} to ${COURSE_ENROL_MODE_LABEL[nextMode]}.`,
    at: FieldValue.serverTimestamp(),
  });

  await ref.update({
    enrolMode: nextMode,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, enrolMode: nextMode });
}
