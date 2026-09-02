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
 * Three refusals sit on top of the table:
 *
 *  1. **Reopening needs `confirm: true`.** `closed -> open` is legitimate (the
 *     extend-the-deadline path) and is not something to do by tapping a
 *     dropdown, so the client types a confirmation first.
 *  2. **Opening needs the round to be READY.** `roundReadiness` is the same
 *     predicate the console's panel renders, so the panel and this refusal
 *     cannot disagree: whatever the panel lists as missing is exactly what
 *     this returns. Opening an unready round is the one irreversible mistake
 *     here, because a real applicant can then reach the form.
 *  3. **An archived round cannot be opened.** Archiving is how a round is put
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
  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});

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

  const after = await ref.get();
  return NextResponse.json({
    ok: true,
    changed: true,
    status: next,
    round: serialiseRound(normalizeAdmissionRound(after.id, after.data() ?? {})),
  });
}
