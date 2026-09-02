import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  COURSE_RUN_STATUSES,
  COURSE_RUN_STATUS_LABEL,
  sanitizeWeekPlan,
  weekDocId,
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
 *
 * LEAVING DRAFT IS A ONE-WAY DOOR for the week plan, so this route also owns
 * the last check on it. See `draftExitBlocker` below.
 */

/**
 * The number of taught slots whose plan `weekId` is not the id their own week
 * number resolves to. `courseMutations.weekAddressDrift()` computes the same
 * thing for the builder's panel; this is the server's own count, because a
 * route may not import a "use client" module.
 */
function weekAddressDriftCount(rawPlan: unknown): number {
  let taught = 0;
  let drifted = 0;
  for (const entry of sanitizeWeekPlan(rawPlan)) {
    if (entry.kind !== "week") continue;
    taught += 1;
    if (entry.weekId !== weekDocId(taught)) drifted += 1;
  }
  return drifted;
}

/**
 * The refusal that makes the draft boundary mean something.
 *
 * A reorder in the week plan builder preserves each slot's `weekId` and
 * renumbers positionally, so the plan can say "slot 2 is week 2, document w05"
 * while every member-facing surface opens `weekDocId(2)`. That is reconcilable
 * for free in draft and nowhere else: the normalise route refuses outside
 * draft, and `weekPlanLockRespected()` in firestore.rules pins the plan for
 * non-admins from the same boundary. So a run allowed to leave draft with the
 * two spellings disagreeing has that mismatch frozen into it for the whole of
 * the cohort's life, and every learner opens a different document than the one
 * the admin arranged.
 *
 * The window to fix it is open right up to this call and shut immediately
 * after, which is exactly where the check belongs.
 */
function draftExitBlocker(
  from: CourseRunStatus,
  to: CourseRunStatus,
  rawPlan: unknown,
): string | null {
  if (from !== "draft" || to === "draft") return null;
  const drifted = weekAddressDriftCount(rawPlan);
  if (drifted === 0) return null;
  return `${
    drifted === 1 ? "One week is" : `${drifted} weeks are`
  } addressed two different ways in this run's week plan, and leaving draft freezes that for good. Open the run's Week plan section and use Normalise week ids first.`;
}

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

  // The last moment the week ids can still be reconciled. After this update
  // both the normalise route and the rules refuse, whatever the plan says.
  const blocker = draftExitBlocker(currentStatus, nextStatus, data.weekPlan);
  if (blocker) {
    return NextResponse.json({ error: blocker }, { status: 409 });
  }

  await ref.update({
    status: nextStatus,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, status: nextStatus });
}
