import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import {
  EXERCISE_LIMITS,
  exerciseResponseId,
  normalizeExerciseResponse,
  type CourseExerciseResponseDoc,
  type ExerciseReviewStatus,
} from "@/lib/firestore/courseExercises";
import { normalizeCourseWeek, validateSubmissionUrl } from "@/lib/firestore/courses";

/**
 * A member saving or submitting ONE weekly exercise. This route is the only
 * write path to `courseExerciseResponses` — the collection is `allow write: if
 * false` in firestore.rules — and it exists because the two things that make a
 * submission valid are both beyond what rules can express.
 *
 * ── THE RESPONSE-TYPE GATE (why this can't be a client write) ───────────────
 * The exercise DEFINITION on the week doc decides what may be submitted: a
 * `"text"` exercise takes a written answer and rejects a link; a `"link"`
 * exercise takes a URL and rejects prose. Checking that from rules would mean
 * fetching `courseRuns/{runId}/weeks/{weekId}` and searching an array inside a
 * rules expression — and the URL check (`validateSubmissionUrl`) is string
 * parsing rules cannot do at all. So the definition is read here, the type is
 * ASSERTED onto the stored doc from the definition, and a client-sent type is
 * never consulted. The field belonging to the other type is deleted on every
 * write, so an author flipping an exercise from text to link cannot leave a
 * stale answer of the wrong kind behind.
 *
 * ── EDITABLE UNTIL REVIEWED ─────────────────────────────────────────────────
 * A row whose `reviewStatus` is anything other than `"unreviewed"` is frozen:
 * this route 409s rather than overwriting it. That is the whole locking
 * mechanism — the review route setting a status IS what locks the member out,
 * and setting the status back to `"unreviewed"` is the only way to hand editing
 * back. Nothing else in the feature keys off a separate "locked" flag.
 *
 * Because the same write that checks the lock also RE-ASSERTS
 * `reviewStatus: "unreviewed"`, the check and the write must be ONE atomic
 * step — see the transaction comment below. A verdict landing between a
 * non-transactional read and its write would be silently undone.
 *
 * ── WHO MAY WRITE ───────────────────────────────────────────────────────────
 * An ACTIVE `learner` enrolment on this run, and nobody else. Facilitators,
 * track leads and admins deliberately cannot submit on anyone's behalf,
 * including their own — a submission is the member's own word, and a route that
 * let staff write one would make the review queue unreadable as evidence. The
 * enrolment is ADDRESSED (`courseEnrolmentId`), never queried, so there is no
 * way to spell another member's row; and the doc id below is built from the
 * caller's own uid, so this route cannot touch anyone else's response.
 *
 * Member content is PLAIN TEXT or a validated URL — typed `string`, never
 * `Block[]`, and rendered as text nodes only by `MemberText`. Nothing here does
 * any HTML processing, and nothing may start.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract every exercise surface renders from)
// ---------------------------------------------------------------------------

/**
 * One member's response to one exercise, as it travels. Exported here and
 * imported by the my-exercises, group-queue and review routes — the shape is
 * defined once so the member's own view and the facilitator's queue can never
 * disagree about what a response looks like.
 *
 * PII: `reviewerName` is a display name resolved through `displayNameOf`,
 * NEVER an email. There is no email-shaped field on this type and none may be
 * added — it is served to members and facilitators alike.
 */
export type ExerciseResponseWire = {
  /** The deterministic doc id. Construct-only, never parsed (see courseExercises.ts). */
  id: string;
  /** Week doc id ("w03"), not a week number — stable across copy-forward. */
  weekId: string;
  /**
   * ALWAYS the number derived from `weekId`, never the week doc's own
   * `weekNumber` field — that is the stored invariant every reader filters on
   * (see the assignment in POST below).
   */
  weekNumber: number;
  exerciseId: string;
  /** Server-asserted from the exercise definition — never the client's word. */
  responseType: "text" | "link";
  /** Non-null only on a `"text"` exercise. Plain text, rendered as text nodes. */
  text: string | null;
  /** Non-null only on a `"link"` exercise. Passed `validateSubmissionUrl`. */
  linkUrl: string | null;
  /** ISO 8601. Null while the row is still an autosaved draft. */
  submittedAt: string | null;
  reviewStatus: ExerciseReviewStatus;
  /** Display name of the facilitator who reviewed. Never an email. */
  reviewerName: string | null;
  reviewerComment: string | null;
  /** ISO 8601, or null on a row nobody has acted on. */
  reviewedAt: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/**
 * Week doc ids come from `weekDocId()`, which zero-pads to two digits for the
 * 1..60 range the week plan allows — so "w01".."w60" is the whole space.
 */
const WEEK_ID = /^w(\d{2})$/;

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator and `doc()` would throw — a 500 out of a member action. Same guard
 * as `runAccess.ts`, deliberately identical so the gate and the routes agree
 * about what counts as an addressable id.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address. (Same local helper P1/P5/P6/P7
 * carry; route handlers don't import from one another, so it is duplicated on
 * purpose.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Thrown out of the write transaction to abort it with a specific response.
 * A `Response` cannot be returned from inside the callback — it would abort
 * nothing and be swallowed as the transaction's result — so the refusal
 * travels as a typed sentinel and is mapped back in the catch. (Same shape as
 * `RemoveError` in the enrolment-remove route.)
 */
class SubmitError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string; exerciseId: string }> },
) {
  const { runId, exerciseId } = await ctx.params;
  if (!isAddressableId(runId) || !isAddressableId(exerciseId)) {
    return NextResponse.json({ error: "Exercise not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: {
    weekId?: unknown;
    text?: unknown;
    linkUrl?: unknown;
    submit?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const weekId = typeof body.weekId === "string" ? body.weekId : "";
  const weekIdMatch = WEEK_ID.exec(weekId);
  const weekIdNumber = weekIdMatch ? Number(weekIdMatch[1]) : 0;
  if (weekIdNumber < 1 || weekIdNumber > MAX_WEEK_NUMBER) {
    return NextResponse.json(
      { error: 'weekId must be a week id like "w03".' },
      { status: 400 },
    );
  }

  /** `true` = "this is my answer, review it"; `false`/absent = autosaved draft. */
  const submit = body.submit === true;

  // ---- Access: an ACTIVE LEARNER enrolment, nothing else (see module comment)
  const enrolSnap = await db
    .collection("courseEnrolments")
    .doc(courseEnrolmentId(runId, actor.uid))
    .get();
  const enrolment = enrolSnap.exists
    ? normalizeCourseEnrolment(enrolSnap.id, enrolSnap.data() ?? {})
    : null;
  if (!enrolment || enrolment.status !== "active" || enrolment.role !== "learner") {
    // Deliberately specific rather than a bare "Forbidden": the week page shows
    // the exercises section to facilitators and admins too, and the honest
    // answer leaks nothing the caller doesn't already know about themselves.
    return NextResponse.json(
      { error: "Only an active member of this run can submit exercises." },
      { status: 403 },
    );
  }

  // ---- The exercise DEFINITION is the gate ---------------------------------
  // `published` is deliberately NOT checked: it is the week page's render gate,
  // and a member who has the week open has already been shown these prompts.
  const weekSnap = await db
    .collection("courseRuns")
    .doc(runId)
    .collection("weeks")
    .doc(weekId)
    .get();
  if (!weekSnap.exists) {
    return NextResponse.json({ error: "Week not found" }, { status: 404 });
  }
  const week = normalizeCourseWeek(weekSnap.id, weekSnap.data() ?? {});
  const exercise = week.exercises.find((x) => x.id === exerciseId);
  if (!exercise) {
    return NextResponse.json({ error: "Exercise not found" }, { status: 404 });
  }

  // ---- THE `weekNumber` INVARIANT -----------------------------------------
  // THE STORED `weekNumber` IS ALWAYS THE NUMBER DERIVED FROM `weekId`. Every
  // reader resolves a week the same way — `weekDocId(N)` for the doc, then
  // `where("weekNumber", "==", N)` for the rows (my-exercises, the group review
  // queue) — so the number written here has to be the one they derive, or a row
  // is filed under a week nobody queries with it.
  //
  // It is deliberately NOT the week DOCUMENT's `weekNumber` field. The data
  // model decouples the two on purpose: `weekId` is stable across copy-forward,
  // while the field is a re-derived DISPLAY label, so inserting a break can
  // leave doc "w03" carrying `weekNumber: 4`. Storing 4 for a /weeks/3
  // submission would make the answer vanish from the page that wrote it, while
  // the deterministic doc id let the next answer silently overwrite it.
  //
  // `weekIdNumber` is already bounds-checked above (1..MAX_WEEK_NUMBER).
  const weekNumber = weekIdNumber;

  // ---- THE RESPONSE-TYPE GATE ---------------------------------------------
  // The definition decides which field is even legal. Sending the wrong one is
  // rejected outright rather than ignored: silently dropping a member's answer
  // would look like a save that worked.
  const textSent = body.text !== undefined && body.text !== null;
  const linkSent = body.linkUrl !== undefined && body.linkUrl !== null;
  if (exercise.responseType === "text" && linkSent) {
    return NextResponse.json(
      { error: "This exercise takes a written answer, not a link." },
      { status: 400 },
    );
  }
  if (exercise.responseType === "link" && textSent) {
    return NextResponse.json(
      { error: "This exercise takes a link, not a written answer." },
      { status: 400 },
    );
  }

  let text = "";
  let linkUrl = "";
  if (exercise.responseType === "text") {
    if (textSent && typeof body.text !== "string") {
      return NextResponse.json({ error: "That answer looks malformed." }, { status: 400 });
    }
    text = textSent ? (body.text as string).trim() : "";
    // The exercise's own cap, never above the collection-wide ceiling. A
    // definition with a nonsense cap falls back to the ceiling rather than
    // locking the member out of answering at all.
    const max = Math.min(
      EXERCISE_LIMITS.responseText,
      exercise.maxLength > 0 ? exercise.maxLength : EXERCISE_LIMITS.responseText,
    );
    // Rejected, not truncated: silently binning the tail of someone's answer is
    // worse than a clear error, and the client counter (CountedTextarea's
    // maxLength) means a well-behaved caller never reaches this.
    if (text.length > max) {
      return NextResponse.json(
        { error: `That answer is too long (maximum ${max} characters).` },
        { status: 400 },
      );
    }
    if (submit && !text) {
      return NextResponse.json(
        { error: "Please write an answer before submitting." },
        { status: 400 },
      );
    }
  } else {
    if (linkSent && typeof body.linkUrl !== "string") {
      return NextResponse.json({ error: "That link looks malformed." }, { status: 400 });
    }
    linkUrl = linkSent ? (body.linkUrl as string).trim() : "";
    // Empty on an autosave is a legitimate "still an empty draft" and clears the
    // field. Anything non-empty is validated on BOTH paths — the same
    // `validateSubmissionUrl` the client form uses for inline errors, so a
    // debounced autosave never reaches here with a half-typed URL.
    if (submit || linkUrl) {
      const problem = validateSubmissionUrl(linkUrl, EXERCISE_LIMITS.linkUrl);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }
  }

  // ---- The row ------------------------------------------------------------
  // One response per (run, member, week, exercise), STRUCTURALLY: the id is
  // deterministic, so an edit replaces rather than duplicating, and there is no
  // query anywhere in this route that could reach another member's row.
  const id = exerciseResponseId(runId, actor.uid, weekId, exerciseId);
  const ref = db.collection("courseExerciseResponses").doc(id);

  // TRANSACTIONAL, because the lock check and the write are ONE decision. The
  // read decides whether the row is still editable; the write re-asserts
  // `reviewStatus: "unreviewed"`. Split apart, a facilitator's verdict landing
  // between them is silently reverted — the row returns to "unreviewed" (the
  // member regains edit access) while `reviewerUid`/`reviewedAt`/
  // `reviewerComment` stay stamped, and the queue believes the verdict was
  // sent. That is precisely the concurrency the queue's own workflow produces:
  // a member's debounced autosave still in flight when the facilitator clicks a
  // verdict. Re-reading inside the transaction makes the 409 authoritative.
  //
  // The prior row is the transaction's RESULT (rather than an outer variable
  // assigned from the callback) so the echo below reads what the committed
  // attempt actually saw, retries included.
  let existing: CourseExerciseResponseDoc | null;
  try {
    existing = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prior = snap.exists
        ? normalizeExerciseResponse(id, snap.data() ?? {})
        : null;

      // EDITABLE UNTIL REVIEWED — see the module comment. This 409 is the lock,
      // and the review route setting a status is what engages it. Thrown, not
      // returned: the transaction must abort without writing, and a `Response`
      // built in here would abort nothing (see `SubmitError`).
      if (prior && prior.reviewStatus !== "unreviewed") {
        throw new SubmitError(
          "Your facilitator has already reviewed this answer, so it can't be edited. Ask them to reopen it if you need to change it.",
          409,
        );
      }

      // Built INSIDE the callback so every attempt starts from a clean object:
      // a `submittedAt` decided against one attempt's read must not leak into a
      // retry that read a different row.
      const write: Record<string, unknown> = {
        runId,
        uid: actor.uid,
        weekId,
        weekNumber,
        exerciseId,
        responseType: exercise.responseType,
        // Re-asserted on every write. It is already "unreviewed" (the check
        // above guarantees it, now atomically), but stating it keeps a
        // hand-edited doc from carrying a status this write doesn't support.
        reviewStatus: "unreviewed",
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (exercise.responseType === "text") {
        write.text = text ? text : FieldValue.delete();
        write.linkUrl = FieldValue.delete();
      } else {
        write.linkUrl = linkUrl ? linkUrl : FieldValue.delete();
        write.text = FieldValue.delete();
      }
      if (submit) {
        // Re-submitting an already-submitted-but-unreviewed row restamps it:
        // the member's latest word is what the facilitator should see queued.
        write.submittedAt = FieldValue.serverTimestamp();
      } else if (!prior) {
        write.submittedAt = null;
      }
      // An autosave on an EXISTING row deliberately leaves `submittedAt` alone.
      // A member tidying a typo after submitting has not withdrawn the
      // submission, and un-submitting them by accident would silently drop them
      // out of the facilitator's queue.

      tx.set(ref, write, { merge: true });
      return prior;
    });
  } catch (err) {
    if (err instanceof SubmitError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[courses submit] transaction failed", runId, weekId, exerciseId, err);
    return NextResponse.json({ error: "Couldn't save that answer." }, { status: 500 });
  }

  // The reviewer fields are untouched by this route, so they are echoed from
  // the stored row. They are normally empty; they are non-empty exactly when a
  // facilitator left feedback and then set the status back to "unreviewed" to
  // hand editing back, which is the case worth preserving.
  let reviewerName: string | null = null;
  if (existing?.reviewerUid) {
    const reviewerSnap = await db.collection("users").doc(existing.reviewerUid).get();
    reviewerName = reviewerSnap.exists
      ? displayNameOf(reviewerSnap.data() ?? {})
      : "NAISI member";
  }

  // Echoed from what was just written rather than re-read: a re-read would cost
  // a doc read on every 900ms autosave to resolve two server timestamps that
  // differ from these by milliseconds. The STORED values are the authoritative
  // ones; these are what the member's own screen shows back to them.
  const response: ExerciseResponseWire = {
    id,
    weekId,
    weekNumber,
    exerciseId,
    responseType: exercise.responseType,
    text: exercise.responseType === "text" ? (text || null) : null,
    linkUrl: exercise.responseType === "link" ? (linkUrl || null) : null,
    submittedAt: iso(submit ? new Date() : (existing?.submittedAt ?? null)),
    reviewStatus: "unreviewed",
    reviewerName,
    reviewerComment: existing?.reviewerComment ?? null,
    reviewedAt: iso(existing?.reviewedAt ?? null),
  };

  return NextResponse.json({ ok: true, response });
}
