import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  CIRCULATION_LIMITS,
  CIRCULATIONS_COLLECTION,
  normalizeCirculation,
  normalizeResponse,
  normalizeReview,
  RESPONSES_SUBCOLLECTION,
  REVIEWS_SUBCOLLECTION,
  taskStatusForResponse,
  type CirculationDoc,
} from "@/lib/firestore/circulations";
import { questionsOf } from "@/lib/firestore/worksheets";
import { isAddressableId, isCirculationStaff } from "@/lib/worksheets/access";
import { notifyWorksheetEvent } from "@/lib/worksheets/notify";

/**
 * "Send this back": the one write that turns staff notes into something the
 * recipient can read.
 *
 * ── WHY A ROUTE, WHEN STAFF ALREADY WRITE THE REVIEW CLIENT-DIRECT ──────────
 * Because returning is a COPY across a trust boundary, and the boundary is the
 * whole reason the review lives in its own document. `reviews/{uid}` is staff
 * only; `responses/{uid}` is readable by the recipient. A client that could
 * write `returned` onto the response could write a score into it, and the
 * promise that scores are never seen by the recipient would be a convention
 * rather than a fact. Here the copy is built field by field into
 * `ReturnedFeedback`, a type with nowhere to put a score, so a change that
 * started copying one would not typecheck.
 *
 * ── WHAT IS COPIED, AND WHAT THE TOGGLES DECIDE ─────────────────────────────
 * `perQuestionFeedback` decides whether the per-question strings travel;
 * `overallFeedback` decides the single box. Off means the field is written
 * EMPTY rather than left alone, because this route is the only writer of
 * `returned` and a half-written map from a previous return would otherwise
 * survive a config change nobody would connect it to. Empty strings are
 * dropped on the way in, so a reviewer who typed nothing under question three
 * does not send an empty remark about it.
 *
 * ── ONLY QUESTIONS THAT STILL EXIST ─────────────────────────────────────────
 * The review is written client-direct with `merge: true`, and a merge never
 * deletes a nested key, so an entry for a question the copy editor has since
 * removed survives in `perQuestion` indefinitely. Copying it here would put
 * feedback about a question that is no longer on the worksheet into a document
 * the recipient reads, where nothing renders it and nothing explains it. So the
 * copy is filtered against the circulation's OWN items, which are read in this
 * transaction anyway. The stale entry itself stays in the staff document: it is
 * a colleague's writing, and deleting it is not this route's call.
 *
 * ── RETURNING IS REFUSED WHEN THE CIRCULATION DOES NOT RETURN ───────────────
 * `returnToRecipient` off is the sender saying feedback stays with the
 * reviewers, and the response is already finished (its task went green on
 * submit). Copying feedback onto it anyway would put words in front of a
 * recipient the sender decided would not see them, so this is a 409 and not a
 * silent success: the caller is allowed, the circulation simply does not do
 * this. The panel hides the button for the same reason, but a hidden button is
 * manners and this is the guarantee.
 *
 * The consequence worth knowing, because it has no fix inside this file: a
 * response submitted while the toggle was ON parks its task in `review`, and
 * turning the toggle off afterwards leaves that task with no path to Done
 * except the close route archiving it. The repair belongs where the toggle is
 * written (the settings panel re-deriving the parked task statuses), not here:
 * this route cannot tell a mid-flight change of mind from a sender who never
 * returned anything, and returning feedback nobody asked to be sent is the
 * worse of the two mistakes.
 *
 * ── A CLOSED CIRCULATION CAN STILL BE REVIEWED, DELIBERATELY ────────────────
 * Unlike unfreezing, which refuses on a closed circulation, this route does not
 * look at `status` at all, and the asymmetry is the point. Closing stops
 * SUBMISSIONS; reviewing what was already submitted is exactly the work that
 * carries on afterwards, and often the reason a sender closes a circulation at
 * the deadline. Unfreezing would hand somebody their answers back and then
 * refuse to accept them, which is why that one is refused and this one is not.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 * The gate and the write are one decision, as in the submit route: an unfreeze
 * landing between a loose read and its write would return feedback onto a
 * response somebody had been handed back, and the counter would count it twice.
 * Refusals travel out as a typed error, because a `Response` built inside the
 * callback aborts nothing.
 */

type ReturnOutcome = {
  circulation: CirculationDoc;
  taskId: string | null;
};

class ReturnError extends Error {
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
  // Both segments, because both are spelled into a document path below and a
  // decoded `%2F` in either would throw out of `doc()` as a 500.
  if (!isAddressableId(circulationId) || !isAddressableId(uid)) {
    return NextResponse.json({ error: "Response not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulationRef = db.collection(CIRCULATIONS_COLLECTION).doc(circulationId);
  const responseRef = circulationRef.collection(RESPONSES_SUBCOLLECTION).doc(uid);
  const reviewRef = circulationRef.collection(REVIEWS_SUBCOLLECTION).doc(uid);

  let outcome: ReturnOutcome;
  try {
    outcome = await db.runTransaction(async (tx) => {
      const [circulationSnap, responseSnap, reviewSnap] = await tx.getAll(
        circulationRef,
        responseRef,
        reviewRef,
      );
      if (!circulationSnap.exists) throw new ReturnError("Circulation not found", 404);
      const circulation = normalizeCirculation(circulationSnap.id, circulationSnap.data() ?? {});

      // Before the response is even looked at: a stranger poking at ids learns
      // nothing about who was sent what.
      if (!isCirculationStaff(circulation, actor)) {
        throw new ReturnError("You can't return feedback on this circulation.", 403);
      }
      if (!responseSnap.exists) throw new ReturnError("Response not found", 404);
      const response = normalizeResponse(responseSnap.id, responseSnap.data() ?? {});

      if (!circulation.reviewConfig.returnToRecipient) {
        throw new ReturnError(
          "This circulation keeps feedback with the reviewers, so there is nothing to send back.",
          409,
        );
      }
      if (response.state !== "submitted") {
        throw new ReturnError(
          response.state === "reviewed"
            ? "This one has already been returned."
            : "This person hasn't submitted their answers yet.",
          409,
        );
      }

      const review = reviewSnap.exists
        ? normalizeReview(reviewSnap.id, reviewSnap.data() ?? {})
        : null;

      // Built key by key from the two toggles. `normalizeReview` has already
      // dropped empty strings and entries with neither half, so what survives
      // here is what somebody actually wrote.
      const perQuestion: Record<string, { feedback: string }> = {};
      if (review && circulation.reviewConfig.perQuestionFeedback) {
        // The questions as they stand NOW, so feedback on one the copy editor
        // has removed is left behind rather than sent (see the header).
        const liveQuestionIds = new Set(questionsOf(circulation.items).map((q) => q.id));
        for (const [questionId, entry] of Object.entries(review.perQuestion)) {
          if (!liveQuestionIds.has(questionId)) continue;
          const feedback = (entry.feedback ?? "").trim();
          if (!feedback) continue;
          perQuestion[questionId] = { feedback: feedback.slice(0, CIRCULATION_LIMITS.feedback) };
        }
      }
      const overall =
        review && circulation.reviewConfig.overallFeedback
          ? review.overall.trim().slice(0, CIRCULATION_LIMITS.overall)
          : "";

      const taskStatus = taskStatusForResponse("reviewed", circulation.reviewConfig);
      // The last READ: a transaction refuses one after a write. The task may
      // have been deleted by an admin, and a blind update on a missing document
      // would fail the whole transaction over a card nobody needs.
      const taskSnap = response.taskId
        ? await tx.get(db.collection("tasks").doc(response.taskId))
        : null;

      tx.update(responseRef, {
        state: "reviewed",
        reviewedAt: FieldValue.serverTimestamp(),
        returned: {
          perQuestion,
          overall,
          returnedAt: FieldValue.serverTimestamp(),
          returnedByUid: actor.uid,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(circulationRef, {
        reviewedCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (taskSnap?.exists) {
        tx.update(taskSnap.ref, {
          status: taskStatus,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return { circulation, taskId: response.taskId };
    });
  } catch (err) {
    if (err instanceof ReturnError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[worksheets return] transaction failed", circulationId, uid, err);
    return NextResponse.json({ error: "Couldn't return that feedback." }, { status: 500 });
  }

  // AFTER the commit, never inside: a transaction can be retried, and a retried
  // send is a second email about one piece of feedback.
  await notifyWorksheetEvent(db, {
    circulation: outcome.circulation,
    circulationId,
    event: "feedbackReturned",
    recipientUids: [uid],
    actor: { uid: actor.uid, displayName: actor.displayName ?? "Your reviewers" },
    taskIds: outcome.taskId ? { [uid]: outcome.taskId } : undefined,
  });

  return NextResponse.json({ ok: true });
}
