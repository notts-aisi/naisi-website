import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  ADMISSION_ROUND_FIELD_LIMITS,
  nextAdmissionStageId,
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} from "@/lib/firestore/admissionRounds";
import { sanitizeSignupForm, validateQuestionLimits } from "@/lib/firestore/events";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
  canAuthorRounds,
  parseInstant,
  parseWallClock,
  serialiseStage,
} from "@/lib/admissions/roundRoutes";

/**
 * One stage of a round: the block of questions that releases on a date.
 *
 * ## Why the questions live down here at all
 *
 * `admissionRounds/{roundId}/stages/{stageId}` is `allow read, write: if
 * false`, and that is the WHOLE timed-release guarantee. Questions authored on
 * a course run were readable by any signed-in account the moment they were
 * saved, because `courseRuns` is `allow read: if isSignedIn()`, so a release
 * date there was a `display: none` anybody's devtools would undo. Down here
 * the only way a question reaches a browser is a route that called
 * `isStageReleased` first, and this route is the only writer.
 *
 * ## The limit check is HERE and not in the sanitiser
 *
 * `sanitizeSignupForm` is `raw.filter(isValidQuestion)`, so a range check
 * inside that predicate would DELETE a question whose character limit was
 * mistyped rather than complain about it. The author would save 5000, get a
 * form with one fewer question, and have nothing on screen saying so. So the
 * form is sanitised with `clampLimits: false` (keeping the number exactly as
 * typed) and handed to `validateQuestionLimits`, which names the offending
 * question in a 400. Clamping happens only on read paths, where there is
 * nobody left to ask.
 */

const L = ADMISSION_ROUND_FIELD_LIMITS;

const STAGE_ID = /^s\d+$/;

export async function PUT(
  req: Request,
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
  if (!STAGE_ID.test(stageId)) {
    return NextResponse.json({ error: "That is not a stage id." }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});

  /**
   * ## Creating and editing are DIFFERENT requests
   *
   * A PUT that infers which one it is from whether the id happens to exist is
   * how a new stage lands on a live one. `stageIds` has holes in it after a
   * delete, so an id derived from its length can name a stage that is still
   * there, and the write below is a merge: the new stage's empty question list
   * would blank the questions on the one it collided with, and nothing on
   * screen would say so.
   *
   * So the client states its intention and the server refuses the mismatch in
   * both directions. `create: true` on an id the round already has is a stale
   * console, and an edit to an id the round no longer has is a stale console
   * too; neither is a write to make quietly.
   */
  const wantsCreate = body.create === true;
  const existingIndex = round.stageIds.indexOf(stageId);
  const isNew = existingIndex === -1;
  if (wantsCreate && !isNew) {
    return NextResponse.json(
      {
        error: `This round already has a stage ${stageId}. Reload the console before adding another, or the new one would overwrite it.`,
      },
      { status: 409 },
    );
  }
  if (!wantsCreate && isNew) {
    return NextResponse.json(
      { error: "That stage is not on this round any more. Reload the console." },
      { status: 404 },
    );
  }
  if (isNew) {
    if (round.stageIds.length >= L.maxStages) {
      return NextResponse.json(
        { error: `A round takes at most ${L.maxStages} stages.` },
        { status: 400 },
      );
    }
    const expected = nextAdmissionStageId(round.stageIds);
    if (stageId !== expected) {
      // One past the highest id this round has used, never the list's length:
      // see `nextAdmissionStageId`.
      return NextResponse.json(
        { error: `The next stage on this round is ${expected}.` },
        { status: 400 },
      );
    }
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return NextResponse.json({ error: "Give the stage a name." }, { status: 400 });
  }
  if (label.length > L.stageLabel) {
    return NextResponse.json(
      { error: `That stage name is ${label.length - L.stageLabel} characters too long.` },
      { status: 400 },
    );
  }

  const intro = typeof body.intro === "string" ? body.intro.trim() : "";
  if (intro.length > L.stageIntro) {
    return NextResponse.json(
      { error: `The stage introduction is ${intro.length - L.stageIntro} characters too long.` },
      { status: 400 },
    );
  }

  // clampLimits:false, so an authored 5000 arrives at the validator as 5000
  // and the author is told, rather than being silently given 4000.
  const questions = sanitizeSignupForm(body.questions, { clampLimits: false });
  if (questions.length > L.maxStageQuestions) {
    return NextResponse.json(
      { error: `A stage takes at most ${L.maxStageQuestions} questions.` },
      { status: 400 },
    );
  }
  const limitError = validateQuestionLimits(questions);
  if (limitError) {
    return NextResponse.json(
      { error: limitError.error, questionId: limitError.questionId },
      { status: 400 },
    );
  }

  const rawRelease = body.releaseAt;
  let releaseAt: string | null = null;
  if (rawRelease !== null && rawRelease !== undefined && rawRelease !== "") {
    if (typeof rawRelease !== "string" || !isValidDateKey(rawRelease)) {
      // Round-tripped, so 2026-02-31 is refused here rather than releasing
      // with the round because `stageReleaseInstant` could not read it.
      return NextResponse.json(
        { error: "The release date must be a real calendar date." },
        { status: 400 },
      );
    }
    releaseAt = rawRelease;
  }

  const releaseTimeLocal = parseWallClock(body.releaseTimeLocal) ?? "09:00";
  if (body.releaseTimeLocal !== undefined && parseWallClock(body.releaseTimeLocal) === null) {
    return NextResponse.json(
      { error: "The release time must look like 09:00." },
      { status: 400 },
    );
  }

  const parsedClose = parseInstant(
    body.closesAt === undefined ? null : body.closesAt,
    "The stage deadline",
  );
  if (!parsedClose.ok) {
    return NextResponse.json({ error: parsedClose.error }, { status: 400 });
  }
  const closesAt = parsedClose.value;
  if (closesAt && round.closesAt && closesAt.getTime() > round.closesAt.getTime()) {
    // A stage deadline past the round's is a date nobody can meet: the submit
    // route stops accepting anything at the round's own `closesAt`. Printing
    // it would be the discovery-versus-submit disagreement one level down.
    return NextResponse.json(
      {
        error:
          "A stage cannot close after the round does. Move the round's deadline first if the stage really needs longer.",
      },
      { status: 400 },
    );
  }

  const order = isNew ? round.stageIds.length : existingIndex;
  const stageRef = roundRef.collection(STAGES_SUBCOLLECTION).doc(stageId);

  if (isNew && (await stageRef.get()).exists) {
    // The round does not list this stage but a document is sitting at the id.
    // Nothing this route does can produce that (a delete takes the row and the
    // list entry in one batch), so it is somebody else's leftover and a
    // creation on top of it would be the overwrite this whole path is written
    // to prevent.
    return NextResponse.json(
      {
        error: `There is already a stage document at ${stageId} that this round does not list. Somebody has to look at it before another stage takes that id.`,
      },
      { status: 409 },
    );
  }

  const batch = db.batch();
  batch.set(
    stageRef,
    {
      roundId,
      label,
      intro,
      questions,
      releaseAt,
      releaseTimeLocal,
      closesAt,
      locksOnSubmit: body.locksOnSubmit === true,
      order,
      ...(isNew
        ? { manualReleasedAt: null, createdAt: FieldValue.serverTimestamp() }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    // An EDIT merges, so a manual release already stamped on this stage
    // survives a change to its wording: a release cannot be taken back. A
    // CREATE writes the whole document, because there is nothing of this
    // stage's to keep and a merge would inherit whatever a leftover row held.
    isNew ? {} : { merge: true },
  );
  if (isNew) {
    batch.update(roundRef, {
      // arrayUnion rather than a rewritten list: two creates racing each other
      // can then only ever produce the ids they asked for, never a duplicate.
      stageIds: FieldValue.arrayUnion(stageId),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  const saved = await stageRef.get();
  return NextResponse.json({
    stage: serialiseStage(normalizeAdmissionStage(saved.id, saved.data() ?? {}), true),
  });
}

/**
 * Delete a stage.
 *
 * Refused once ANY application exists on the round, in draft or submitted.
 * Answers are stored against a stage id on the application row, so removing
 * the stage strands them: a submitted answer to a question nobody can see the
 * wording of any more is worse than a stage left in place and emptied.
 */
export async function DELETE(
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

  if (!round.stageIds.includes(stageId)) {
    return NextResponse.json({ error: "Stage not found" }, { status: 404 });
  }
  if (round.stageIds.length === 1) {
    return NextResponse.json(
      {
        error:
          "A round needs at least one stage. Empty this one instead of deleting it.",
      },
      { status: 409 },
    );
  }

  const started =
    (round.applicationCounts.draft ?? 0) + (round.applicationCounts.submitted ?? 0);
  if (started > 0) {
    return NextResponse.json(
      {
        error: `${started} ${started === 1 ? "person has" : "people have"} already started an application on this round, and their answers are filed against this stage. Empty the stage rather than deleting it.`,
      },
      { status: 409 },
    );
  }

  const batch = db.batch();
  batch.delete(roundRef.collection(STAGES_SUBCOLLECTION).doc(stageId));
  batch.update(roundRef, {
    stageIds: FieldValue.arrayRemove(stageId),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  // `order` is the position in `stageIds`, so removing one from the middle
  // leaves every later stage claiming a position one too high. Rewrite them
  // from the surviving list rather than leaving the denormalisation lying.
  const remaining = round.stageIds.filter((id) => id !== stageId);
  const fixes = db.batch();
  remaining.forEach((id, index) => {
    fixes.update(roundRef.collection(STAGES_SUBCOLLECTION).doc(id), { order: index });
  });
  await fixes.commit();

  return NextResponse.json({ ok: true, stageIds: remaining });
}
