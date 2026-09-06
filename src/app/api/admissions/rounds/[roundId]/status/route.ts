import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} from "@/lib/firestore/admissionRounds";
import { planStatusChange } from "@/lib/admissions/roundStatus";
import { readinessRefusal, roundReadiness } from "@/lib/admissions/readiness";
import { writeRecordsForRound } from "@/lib/admissions/memberRecordSync";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
  canAuthorRounds,
  serialiseRound,
} from "@/lib/admissions/roundRoutes";

/**
 * Move a round along its lifecycle. THE only writer of
 * `admissionRounds.status`, and the only place the transition table is
 * enforced.
 *
 * The table itself is `ADMISSION_ROUND_TRANSITIONS` in the data layer and is
 * interpreted by `planStatusChange`, which the console's status control calls
 * too, so the moves a button offers and the moves this route accepts are the
 * same list read from the same array. That is safe only because
 * `admissionRounds` is `allow write: if false`: this handler is the sole
 * writer. If a client-direct write is ever allowed onto the round document,
 * the table has to be duplicated into `firestore.rules` in the same change.
 *
 * Four refusals sit on top of the table:
 *
 *  1. **A round being destroyed does not move at all.** See the block on
 *     `destroying` below: this one comes first because it refuses every
 *     transition rather than one of them.
 *  2. **Reopening needs `confirm: true`.** `closed -> open` is legitimate (the
 *     extend-the-deadline path) and is not something to do by tapping a
 *     dropdown, so the client types a confirmation first.
 *  3. **Opening needs the round to be READY.** `roundReadiness` is the same
 *     predicate the console's panel renders, so the panel and this refusal
 *     cannot disagree: whatever the panel lists as missing is exactly what
 *     this returns. Opening an unready round is the one irreversible mistake
 *     here, because a real applicant can then reach the form.
 *  4. **An archived round cannot be opened.** Archiving is how a round is put
 *     out of sight; a round that is both archived and open would be invisible
 *     to staff and live to applicants.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;
  const { roundId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canAuthorRounds(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { status?: unknown; confirm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ref = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Round not found" }, { status: 404 });
  const raw = snap.data() ?? {};
  const round = normalizeAdmissionRound(snap.id, raw);

  /**
   * A ROUND BEING DESTROYED DOES NOT MOVE.
   *
   * The destroy cascade stamps `destroying: true` on the round after it has
   * safely written the member records and before it deletes anything
   * (`src/lib/admissions/destroy.ts`). It runs in pages, so a large round can
   * sit half destroyed between passes, and the marker is the only thing that
   * says so: the status is still whatever it was, and `roundReadiness` still
   * passes because the stages drain last and are still there. Without this
   * refusal an admin could take that half-destroyed round from `closed` back to
   * `open`, real applicants would file applications into it, and the next resume
   * would delete those applications too without anybody having chosen that.
   *
   * It refuses EVERY transition rather than just reopening. Archiving or
   * cancelling a round that is being deleted is not a smaller mistake, it is a
   * write onto a document whose remaining life is measured in passes.
   *
   * The marker is read straight off the raw document rather than through
   * `normalizeAdmissionRound`, because it is the destroy cascade's own field and
   * not part of a round's declared shape. The way out is to finish the destroy,
   * which the round's danger zone offers on the next visit; the marker goes when
   * the round document does.
   */
  if (raw.destroying === true) {
    return NextResponse.json(
      {
        error:
          "A destroy of this round has begun and has not finished, so its status cannot be moved. Open the danger zone on this round and resume the destroy: part of the round is already gone, and reopening it would take applications that the rest of the destroy would then delete.",
      },
      { status: 409 },
    );
  }

  const plan = planStatusChange(round.status, body.status);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.error, code: plan.code }, { status: 409 });
  }
  if (plan.kind === "noop") {
    // A double-tapped control is not an error, and must not stamp an
    // `updatedAt` claiming something moved.
    return NextResponse.json({ ok: true, status: round.status, changed: false });
  }

  const next = body.status as typeof round.status;

  if (plan.requiresConfirmation && body.confirm !== true) {
    return NextResponse.json(
      {
        error: plan.confirmPrompt,
        needsConfirmation: true,
      },
      { status: 409 },
    );
  }

  if (next === "open") {
    if (round.archived) {
      return NextResponse.json(
        {
          error:
            "This round is archived. Bring it back out of the archive before opening it, or applicants would be filling in a form no one is watching.",
        },
        { status: 409 },
      );
    }

    const stagesSnap = await ref.collection(STAGES_SUBCOLLECTION).get();
    const stages = stagesSnap.docs.map((d) => {
      const stage = normalizeAdmissionStage(d.id, d.data() ?? {});
      return { id: stage.id, order: stage.order, questionCount: stage.questions.length };
    });

    const readiness = roundReadiness({ ...round, stages }, new Date());
    if (!readiness.ready) {
      return NextResponse.json(
        {
          error: readinessRefusal(readiness.unmet),
          unmet: readiness.unmet.map((c) => ({ id: c.id, label: c.label, hint: c.hint })),
        },
        { status: 409 },
      );
    }
  }

  await ref.update({ status: next, updatedAt: FieldValue.serverTimestamp() });

  /**
   * SETTLING WRITES THE MEMBER RECORD.
   *
   * A settled round is a finished intake: the decisions are made and the
   * scores have stopped moving, so this is the moment to copy what the
   * committee wants to remember about each applicant onto the applicant (when
   * they applied, what for, the outcome, the score summary and the reviewers'
   * notes) at `memberRecords/{uid}/applications/{roundId}`. That
   * record hangs off the person, so it survives the round being destroyed
   * later, and a future application can be read with the history in view.
   *
   * A FAILURE HERE IS A WARNING, NOT A REFUSAL, and the direction is
   * deliberate. Holding a whole intake in `deciding` because one member
   * record could not be written would punish forty people for one bad row,
   * and nothing is lost by carrying on: the destroy is the operation that
   * cannot tolerate a missing record, and it refuses on exactly that, having
   * first written any entry that is missing itself. So the settle lands, the
   * failures come back in `recordWarning` for the console to show, and the
   * server log names them.
   *
   * The write is deliberately NOT inside the status update: it is a sweep
   * over every application on the round, it is idempotent, and a transaction
   * spanning it would put an unbounded read set around a one-field write.
   */
  let recordWarning: string | null = null;
  if (next === "settled") {
    try {
      const sync = await writeRecordsForRound(db, round, "settle", user.uid);
      if (sync.failed.length > 0) {
        recordWarning =
          `The round is settled, but the member record could not be written for ${sync.failed.length} ` +
          `${sync.failed.length === 1 ? "applicant" : "applicants"}. Nothing is lost yet: a destroy of this ` +
          "round writes any missing record itself, and it refuses outright until every one of them succeeds.";
        console.error(
          "[round-status] member records failed on settle:",
          roundId,
          sync.failed,
        );
      }
    } catch (err) {
      recordWarning =
        "The round is settled, but the member records could not be written. Nothing is lost yet: a destroy " +
        "of this round writes any missing record itself, and it refuses outright until every one of them succeeds.";
      console.error("[round-status] member record sweep failed on settle:", roundId, err);
    }
  }

  const after = await ref.get();
  return NextResponse.json({
    ok: true,
    changed: true,
    status: next,
    ...(recordWarning ? { recordWarning } : {}),
    round: serialiseRound(normalizeAdmissionRound(after.id, after.data() ?? {})),
  });
}
