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
  type CirculationDoc,
} from "@/lib/firestore/circulations";
import {
  computeProgress,
  validateSubmission,
  type SubmissionProblem,
} from "@/lib/firestore/worksheets";
import { isAddressableId } from "@/lib/worksheets/access";
import { notifyWorksheetEvent } from "@/lib/worksheets/notify";

/**
 * "This is my answer": the one write that takes a response out of the
 * recipient's hands.
 *
 * ── WHY A ROUTE AND NOT A CLIENT WRITE ──────────────────────────────────────
 * `firestore.rules` holds the recipient's own writes to `state in ['not-opened',
 * 'started']`, so a client cannot declare itself submitted at all. It must not
 * be able to, because submitting is four things at once: the required questions
 * are checked against the circulation's frozen copy, the response is frozen,
 * the sender's counter moves, and the task crosses the board. Only the first of
 * those could be expressed as a rule, and a client that could do the other
 * three could do them without doing the first.
 *
 * ── ONE TRANSACTION, AND WHY THE READS ARE INSIDE IT ────────────────────────
 * The gate and the write are ONE decision. A close landing between a
 * non-transactional read and its write would accept a submission into a closed
 * circulation; a staff unfreeze landing there would be silently undone. The
 * reads are therefore transactional and the refusals travel out as a typed
 * error (a `Response` built inside the callback would abort nothing and be
 * swallowed as the transaction's result, the same trap the course submit route
 * documents).
 *
 * ── THE STORED PROGRESS IS COSMETIC; THIS IS THE AUTHORITY ──────────────────
 * `progress` is written by the recipient's client on every autosave and is
 * re-derived here from the answers as stored, against the items as stored. So a
 * client that lies about its progress bar cannot talk its way past a required
 * question: `validateSubmission` reads the same two arrays, and it is the
 * function the respond page calls too, which is what makes "the page let me
 * submit but the server refused" impossible rather than merely unlikely.
 *
 * ── OWN RESPONSE ONLY, STRUCTURALLY ─────────────────────────────────────────
 * The response is ADDRESSED at the caller's own uid. There is no uid in the
 * body, no query, and therefore no way to spell somebody else's response
 * however the request is shaped. A caller who was never sent this worksheet has
 * no document at that address and gets a 404.
 */

type SubmitOutcome = {
  circulation: CirculationDoc;
  taskStatus: ReturnType<typeof taskStatusForResponse>;
  /** Who to ask for a review: the reviewers, minus whoever just submitted. */
  reviewerUids: string[];
  /** The submitter's own task, for the reviewers' push deep link. */
  taskId: string | null;
};

/**
 * Thrown out of the transaction to abort it with a specific answer. `problems`
 * rides along so a validation failure can name every question at fault in one
 * response rather than one per attempt.
 */
class SubmitError extends Error {
  constructor(
    message: string,
    public status: number,
    public problems: SubmissionProblem[] = [],
  ) {
    super(message);
  }
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { circulationId } = await ctx.params;
  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulationRef = db.collection(CIRCULATIONS_COLLECTION).doc(circulationId);
  const responseRef = circulationRef.collection(RESPONSES_SUBCOLLECTION).doc(actor.uid);

  let outcome: SubmitOutcome;
  try {
    outcome = await db.runTransaction(async (tx) => {
      const [circulationSnap, responseSnap] = await tx.getAll(circulationRef, responseRef);
      if (!circulationSnap.exists) {
        throw new SubmitError("Circulation not found", 404);
      }
      const circulation = normalizeCirculation(
        circulationSnap.id,
        circulationSnap.data() ?? {},
      );
      // Deliberately the SAME answer as a circulation that does not exist. A
      // person who was never sent this worksheet learns nothing about it.
      if (!responseSnap.exists) {
        throw new SubmitError("You haven't been sent this worksheet.", 404);
      }
      const response = normalizeResponse(responseSnap.id, responseSnap.data() ?? {});

      if (circulation.status !== "open") {
        throw new SubmitError(
          "This worksheet has been closed, so it can't take any more answers.",
          409,
        );
      }
      if (isTerminalResponseState(response.state)) {
        throw new SubmitError(
          "You've already submitted this. An admin can unlock it if you need to change something.",
          409,
        );
      }

      const problems = validateSubmission(circulation.items, response.answers);
      if (problems.length > 0) {
        throw new SubmitError(
          "Some of these answers need another look before this can go in.",
          400,
          problems,
        );
      }

      const taskStatus = taskStatusForResponse("submitted", circulation.reviewConfig);
      // The last READ, and it has to happen before the writes below: a
      // transaction refuses a read after a write. The task may be gone (an
      // admin can delete one), and a blind `update` on a missing document
      // fails the whole transaction, which would cost the recipient their
      // submission over a card nobody needs.
      const taskSnap = response.taskId
        ? await tx.get(db.collection("tasks").doc(response.taskId))
        : null;

      tx.update(responseRef, {
        state: "submitted",
        submittedAt: FieldValue.serverTimestamp(),
        // Re-derived, never the client's number. See the module comment.
        progress: computeProgress(circulation.items, response.answers),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(circulationRef, {
        submittedCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (taskSnap?.exists) {
        tx.update(taskSnap.ref, {
          status: taskStatus,
          // Green only when there is nothing left for staff to do. With
          // `returnToRecipient` on the task sits in Review until the feedback
          // goes back, so stamping a completion here would close a card that
          // is still somebody's queue.
          completedAt: taskStatus === "done" ? FieldValue.serverTimestamp() : null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return {
        circulation,
        taskStatus,
        reviewerUids: circulation.reviewerUids.filter((uid) => uid !== actor.uid),
        taskId: response.taskId,
      };
    });
  } catch (err) {
    if (err instanceof SubmitError) {
      return NextResponse.json(
        err.problems.length > 0
          ? { error: err.message, problems: err.problems }
          : { error: err.message },
        { status: err.status },
      );
    }
    console.error("[worksheets submit] transaction failed", circulationId, actor.uid, err);
    return NextResponse.json({ error: "Couldn't submit those answers." }, { status: 500 });
  }

  // AFTER the commit, never inside: a transaction can be retried, and a retried
  // send is a second email about one submission.
  await notifyWorksheetEvent(db, {
    circulation: outcome.circulation,
    circulationId,
    event: "submitted",
    recipientUids: outcome.reviewerUids,
    actor: { uid: actor.uid, displayName: actor.displayName ?? "A NAISI member" },
    // Every reviewer's message is about the SUBMITTER's task, so they all share
    // one id here (the map is keyed by who receives the message).
    taskIds: outcome.taskId
      ? Object.fromEntries(outcome.reviewerUids.map((uid) => [uid, outcome.taskId as string]))
      : undefined,
  });

  return NextResponse.json({ ok: true, state: "submitted", taskStatus: outcome.taskStatus });
}
