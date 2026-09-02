import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  COURSE_RUN_STATUSES,
  COURSE_RUN_STATUS_LABEL,
  type CourseRunStatus,
} from "@/lib/firestore/courses";
import { canTransition } from "@/lib/courses/runStatus";

/**
 * Move a run along its lifecycle. Gated to admins and `approveCourse`
 * holders — the same two-person rule as events: a drafter may author a run's
 * content, but opening applications or declaring a cohort finished changes
 * what the world sees and what the apply route accepts.
 *
 * The rules alone can express "an approver may write status"; they cannot
 * express WHICH move is legal, so the transition table is the real gate and
 * this route is the only status path the admin UI uses.
 *
 * The table lives in `@/lib/courses/runStatus` so the run editor's dropdown is
 * built from the same data and can never offer a move this route refuses.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveCourse)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { status?: unknown };
  try {
    body = (await req.json()) as { status?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const next = body.status;
  if (!COURSE_RUN_STATUSES.includes(next as CourseRunStatus)) {
    return NextResponse.json({ error: "Unknown run status" }, { status: 400 });
  }
  const nextStatus = next as CourseRunStatus;

  const ref = db.collection("courseRuns").doc(runId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const data = snap.data() ?? {};

  // A run mid-DESTROY refuses every status move, the same 409 the archive
  // route gives for the same reason: the cascade has already stamped
  // `archived` + `destroying` and is deleting rows underneath, so moving the
  // run back to `running` would advertise a half-emptied cohort on every
  // surface that reads the status. The destroy owns the doc until it is gone.
  if (data.destroying === true) {
    return NextResponse.json(
      { error: "This run is being destroyed and its status can't be changed." },
      { status: 409 },
    );
  }

  const raw = data.status;
  const currentStatus = COURSE_RUN_STATUSES.includes(raw as CourseRunStatus)
    ? (raw as CourseRunStatus)
    : "draft";

  // Idempotent: re-sending the status a run already has is a no-op, not an
  // error — a double-clicked button shouldn't surface a failure toast.
  if (currentStatus === nextStatus) {
    return NextResponse.json({ ok: true, status: currentStatus });
  }

  if (!canTransition(currentStatus, nextStatus)) {
    return NextResponse.json(
      {
        error: `Can't move a run from "${COURSE_RUN_STATUS_LABEL[currentStatus]}" to "${COURSE_RUN_STATUS_LABEL[nextStatus]}".`,
      },
      { status: 400 },
    );
  }

  await ref.update({
    status: nextStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, status: nextStatus });
}
