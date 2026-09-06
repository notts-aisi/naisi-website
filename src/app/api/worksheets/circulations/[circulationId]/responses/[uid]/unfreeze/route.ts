import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  CIRCULATIONS_COLLECTION,
  isTerminalResponseState,
  normalizeCirculation,
  normalizeResponse,
  RESPONSES_SUBCOLLECTION,
  taskStatusForResponse,
} from "@/lib/firestore/circulations";
import { isAddressableId } from "@/lib/worksheets/access";

/**
 * The way back from a submitted or reviewed response: an admin unlocks it and
 * the recipient can type again.
 *
 * ── ADMIN ONLY, AND NOT MERELY STAFF ────────────────────────────────────────
 * `docs/worksheets.md` puts it in the permissions table as an admin action, and
 * the reason is the shape of the mistake it undoes. Submitting is somebody
 * declaring "this is my answer"; unfreezing takes that declaration back, clears
 * the feedback that was returned to them and moves a card on their board. Staff
 * of a circulation includes every named reviewer, and being asked to read
 * somebody's answers is not being given the power to reopen them.
 *
 * ── WHAT IS CLEARED, AND WHY `returned` GOES RATHER THAN MOVES ──────────────
 * `submittedAt`, `reviewedAt` and `returned` are all cleared, and the response
 * is stamped `unfrozenAt` / `unfrozenByUid` instead. Keeping the old feedback
 * as history was the alternative and was dropped on purpose: it would sit on a
 * response whose answers are about to change under it, so every sentence in it
 * would be about a version nobody can see any more. The record that it happened
 * is the stamp; the feedback itself is re-written by the next return, out of
 * the review document, which this route does not touch. Staff notes survive an
 * unfreeze precisely because they are staff notes.
 *
 * ── A CLOSED CIRCULATION CANNOT BE UNLOCKED ─────────────────────────────────
 * Closing stops submissions, and the submit route refuses one outright. So
 * unlocking a response on a closed circulation would hand somebody their
 * answers back and then refuse to take them: they could type for an hour and
 * never get past the button. There is no reopen in v1, so the honest answer is
 * a 409 naming the reason rather than a state nobody can leave. The panel
 * disables the button for the same reason, and this is the guarantee.
 *
 * The return route deliberately does the opposite and ignores `status`
 * altogether, and the two decisions are one decision read twice: closing stops
 * SUBMISSIONS. Reviewing what was already submitted is the work that carries on
 * after a deadline, so returning feedback on a closed circulation is ordinary;
 * unlocking a response on one asks somebody to type into a form that will not
 * take it.
 *
 * ── THE COUNTERS ARE WRITTEN ABSOLUTE, NOT DECREMENTED ──────────────────────
 * The circulation is read inside the transaction anyway, so the new value is
 * known, and `FieldValue.increment(-1)` on a counter that is already zero
 * writes minus one: a progress line reading "-1 of 4 submitted" is a bug
 * nobody can explain afterwards and nothing can repair from the client. Floored
 * at zero here. Which counters move depends on where the response was: a
 * reviewed one was counted as submitted AND as reviewed.
 */

class UnfreezeError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ circulationId: string; uid: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { circulationId, uid } = await ctx.params;
  if (!isAddressableId(circulationId) || !isAddressableId(uid)) {
    return NextResponse.json({ error: "Response not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // Checked before anything is read: an admin action refuses on identity alone,
  // so a non-admin cannot use the shape of the answer to learn what exists.
  if (actor.role !== "admin") {
    return NextResponse.json(
      { error: "Only an admin can unlock a submitted worksheet." },
      { status: 403 },
    );
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulationRef = db.collection(CIRCULATIONS_COLLECTION).doc(circulationId);
  const responseRef = circulationRef.collection(RESPONSES_SUBCOLLECTION).doc(uid);

  try {
    await db.runTransaction(async (tx) => {
      const [circulationSnap, responseSnap] = await tx.getAll(circulationRef, responseRef);
      if (!circulationSnap.exists) throw new UnfreezeError("Circulation not found", 404);
      const circulation = normalizeCirculation(circulationSnap.id, circulationSnap.data() ?? {});
      if (!responseSnap.exists) throw new UnfreezeError("Response not found", 404);
      const response = normalizeResponse(responseSnap.id, responseSnap.data() ?? {});

      if (!isTerminalResponseState(response.state)) {
        throw new UnfreezeError("This one isn't locked: they can still edit it.", 409);
      }
      if (circulation.status !== "open") {
        throw new UnfreezeError(
          "This circulation is closed, so unlocking this would leave them unable to submit it again.",
          409,
        );
      }
      const wasReviewed = response.state === "reviewed";

      const taskStatus = taskStatusForResponse("started", circulation.reviewConfig);
      // The last read, before any write. A deleted task must not cost the
      // recipient their unlock.
      const taskSnap = response.taskId
        ? await tx.get(db.collection("tasks").doc(response.taskId))
        : null;

      tx.update(responseRef, {
        state: "started",
        submittedAt: null,
        reviewedAt: null,
        returned: null,
        unfrozenAt: FieldValue.serverTimestamp(),
        unfrozenByUid: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(circulationRef, {
        submittedCount: Math.max(0, circulation.submittedCount - 1),
        ...(wasReviewed
          ? { reviewedCount: Math.max(0, circulation.reviewedCount - 1) }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (taskSnap?.exists) {
        tx.update(taskSnap.ref, {
          status: taskStatus,
          // Cleared rather than left: a green stamp on a card that is back in
          // progress is the board disagreeing with the worksheet it mirrors.
          completedAt: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (err) {
    if (err instanceof UnfreezeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[worksheets unfreeze] transaction failed", circulationId, uid, err);
    return NextResponse.json({ error: "Couldn't unlock that response." }, { status: 500 });
  }

  // NOTHING IS SENT. The circulation's notification switches cover the five
  // events in the contract and unfreezing is not one of them: the recipient
  // learns about it from their own task moving back to In progress, and an
  // admin who wants to say why has a person to say it to. Adding a sixth
  // message here would be inventing a policy the sender never set.
  return NextResponse.json({ ok: true });
}
