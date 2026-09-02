import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { validateAnswers } from "@/lib/events/validateAnswers";
import { isStageReleased } from "@/lib/admissions/stageRelease";
import {
  normalizeAdmissionApplication,
  type AdmissionApplicationStatus,
} from "@/lib/firestore/admissionApplications";
import { serialiseApplicationForOwner } from "@/lib/admissions/applyRoutes";
import {
  ApplyError,
  applicationRef,
  applicationsPaused,
  loadOwnApplication,
  loadRound,
  loadStages,
  readJson,
  requireApplicant,
  requireRecaptcha,
  throttleIp,
  throttleUid,
  windowRefusal,
} from "@/lib/admissions/applyContext";

/**
 * Submit ONE later-released stage, after the first submission has already
 * gone in.
 *
 * ## Why this is a separate route rather than a second submit
 *
 * The autumn round releases its questions weekly. Somebody who submitted in
 * week one is `status: "submitted"` when week three's stage opens, so the
 * whole-application submit route (which moves `draft` to `submitted` and moves
 * two counters) is the wrong shape twice over: there is no counter to move,
 * and the stages they already answered are frozen and must stay that way.
 *
 * This route therefore does exactly one thing: it validates and freezes one
 * stage. Counters are untouched, because the person is already counted as
 * submitted; earlier stages are untouched, because a release cannot reopen
 * something already handed in.
 *
 * ## Answers arrive HERE, not through the draft save
 *
 * `PATCH .../apply` refuses once the application leaves `draft`, so a later
 * stage has no server-side draft of its own: it is answered and submitted in
 * one action, and the client keeps the half-written state in the browser until
 * then. That is a deliberate limitation of the contract rather than an
 * oversight, and it is worth knowing before somebody writes a long answer into
 * a stage-two box on a phone. If per-stage drafts are wanted later, the change
 * is to widen the PATCH gate to "this stage is not frozen" rather than "the
 * application is a draft", and nothing here would need to move.
 *
 * Required questions ARE enforced: this is a submit.
 */

type Ctx = { params: Promise<{ roundId: string; stageId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { roundId, stageId } = await ctx.params;

  const ipBlocked = throttleIp(req, "create");
  if (ipBlocked) return ipBlocked;

  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  const uidBlocked = throttleUid(user.uid, "create");
  if (uidBlocked) return uidBlocked;

  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const captcha = await requireRecaptcha(body, "stage-submit");
  if (captcha) return captcha;

  try {
    const now = new Date();
    const round = await loadRound(db, roundId);

    const closed = windowRefusal(round, now);
    if (closed) return NextResponse.json({ error: closed }, { status: 403 });

    const paused = await applicationsPaused(db);
    if (paused) return NextResponse.json({ error: paused }, { status: 503 });

    const stages = await loadStages(db, roundId);
    const stage = stages.find((candidate) => candidate.id === stageId);
    if (!stage) {
      return NextResponse.json({ error: "That part of the form does not exist." }, { status: 404 });
    }
    // The release boundary again, on the write side. A client that guesses a
    // stage id must not be able to file answers to questions it has never been
    // served, which would put a head start into the reviewer's queue.
    if (!isStageReleased(stage, round, now)) {
      return NextResponse.json(
        { error: `"${stage.label}" has not been released yet.` },
        { status: 403 },
      );
    }

    const appRef = applicationRef(db, roundId, user.uid);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(appRef);
      if (!snap.exists) throw new ApplyError("No application found.", 404);
      const application = normalizeAdmissionApplication(
        snap.id,
        snap.data() ?? {},
        round.availabilityGrid,
      );

      const status: AdmissionApplicationStatus = application.status;
      if (status === "draft") {
        // A first submission moves counters and freezes every released stage
        // at once, so it has to go through the submit route or the round's
        // `draft` count would never come down.
        throw new ApplyError(
          "Submit your application first, and this part will be here afterwards.",
          409,
        );
      }
      if (status === "withdrawn") {
        throw new ApplyError("You withdrew this application.", 409);
      }
      if (application.stageSubmittedAt[stageId]) {
        throw new ApplyError(`You have already submitted "${stage.label}".`, 409);
      }

      const result = validateAnswers(stage.questions, body.answers ?? {}, {
        enforceRequired: true,
      });
      if ("error" in result) {
        throw new ApplyError(result.error, 400, {
          questionId: result.questionId,
          stageId,
        });
      }

      tx.update(appRef, {
        [`stageAnswers.${stageId}`]: result.answers,
        [`stageSubmittedAt.${stageId}`]: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    const loaded = await loadOwnApplication(db, round, user.uid);
    return NextResponse.json({
      ok: true,
      application: loaded
        ? serialiseApplicationForOwner(loaded.application, loaded.accessRequirements)
        : null,
    });
  } catch (err) {
    if (err instanceof ApplyError) return err.toResponse();
    console.error("[admissions apply] stage submit failed", roundId, stageId, err);
    return NextResponse.json({ error: "Could not submit that part." }, { status: 500 });
  }
}
