import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} from "@/lib/firestore/admissionRounds";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
} from "@/lib/admissions/roundRoutes";
import {
  serialiseRoundForApplicant,
  serialiseStageForApplicant,
} from "@/lib/admissions/applyRoutes";

/**
 * The APPLICANT's read of a round's stages: the release boundary, served.
 *
 * `admissionRounds/{roundId}/stages/{stageId}` is `allow read, write: if
 * false`, so this route is the only way a question ever reaches a browser.
 * Every stage goes through `serialiseStageForApplicant`, which asks
 * `isStageReleased` FIRST and returns a smaller object on the unreleased arm
 * rather than building a full one and deleting a key. An unreleased stage
 * therefore has no `questions` field at any point in its construction, which
 * is the difference between a guarantee and a filter somebody can forget.
 *
 * ## Why signed-in rather than open
 *
 * Applying needs an account (owner decision D: register, then apply), so
 * there is no reader of these questions who is not signed in. Requiring the
 * session costs an applicant nothing and keeps a released question set off
 * the open internet, where it would be scraped into whatever answers people
 * paste back in.
 *
 * ## A DRAFT or ARCHIVED round is 404, not empty
 *
 * A round that is not a public thing yet answers exactly as one that does not
 * exist. Its stage LABELS are authoring in progress ("Stage 2: the technical
 * exercise"), and an applicant has no business learning the shape of a form
 * nobody has decided to run. The staff console reads stages through
 * `GET /api/admissions/rounds/[roundId]` instead, which serialises questions
 * for an author.
 *
 * There is no write half here. Stages are authored one at a time through
 * `PUT .../stages/[stageId]`, so this file exports a GET and nothing else and
 * needs no impersonation guard.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const { roundId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return NextResponse.json({ error: "Round not found." }, { status: 404 });
  }
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});
  if (round.archived || round.status === "draft") {
    return NextResponse.json({ error: "Round not found." }, { status: 404 });
  }

  const now = new Date();
  const stagesSnap = await roundRef.collection(STAGES_SUBCOLLECTION).get();
  const stages = stagesSnap.docs
    .map((doc) => normalizeAdmissionStage(doc.id, doc.data() ?? {}))
    .sort((a, b) => a.order - b.order)
    .map((stage) => serialiseStageForApplicant(stage, round, now));

  return NextResponse.json({
    round: serialiseRoundForApplicant(round, now),
    stages,
  });
}
