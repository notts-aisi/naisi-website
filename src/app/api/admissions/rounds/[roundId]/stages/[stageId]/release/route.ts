import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} from "@/lib/firestore/admissionRounds";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
  canAuthorRounds,
  serialiseStage,
} from "@/lib/admissions/roundRoutes";

/**
 * Release a stage BY HAND, now.
 *
 * An explicit POST, never a side effect of a GET. The stage's questions are
 * the one thing on this whole tree that cannot be un-served: once the wording
 * has been out, an applicant who read it early has thinking time nobody else
 * got. A read path that could stamp `manualReleasedAt` would mean a preview,
 * a bot or a mis-ordered render could publish an intake's questions, which is
 * why the field has exactly one writer and it is this handler.
 *
 * `manualReleasedAt` can only ever bring a release FORWARD: `isStageReleased`
 * treats a stamped manual release as released regardless of the schedule, and
 * there is no route that clears it. Pushing one back would be a promise this
 * site cannot keep.
 *
 * Idempotent: pressing it twice reports the release it already made rather
 * than moving the timestamp, so a double tap cannot make the questions look
 * newer than they were.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ roundId: string; stageId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;
  const { roundId, stageId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canAuthorRounds(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});

  const stageRef = roundRef.collection(STAGES_SUBCOLLECTION).doc(stageId);
  const stageSnap = await stageRef.get();
  if (!stageSnap.exists) {
    return NextResponse.json({ error: "Stage not found" }, { status: 404 });
  }
  const stage = normalizeAdmissionStage(stageSnap.id, stageSnap.data() ?? {});

  if (stage.questions.length === 0) {
    return NextResponse.json(
      { error: "This stage has no questions on it yet, so there is nothing to release." },
      { status: 409 },
    );
  }

  if (round.status === "draft" || round.archived) {
    // Releasing a stage of a round nobody can reach does nothing today and
    // would quietly publish it the moment the round opened, which is not what
    // the button says it does.
    return NextResponse.json(
      {
        error:
          "This round is not open yet, so its stages cannot be released. Open the round first.",
      },
      { status: 409 },
    );
  }
  if (round.status === "cancelled") {
    return NextResponse.json(
      { error: "This round is cancelled, so it is not asking anything else." },
      { status: 409 },
    );
  }

  if (stage.manualReleasedAt) {
    return NextResponse.json({
      ok: true,
      alreadyReleased: true,
      stage: serialiseStage(stage, true),
    });
  }

  await stageRef.update({
    manualReleasedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const after = await stageRef.get();
  return NextResponse.json({
    ok: true,
    alreadyReleased: false,
    stage: serialiseStage(normalizeAdmissionStage(after.id, after.data() ?? {}), true),
  });
}
