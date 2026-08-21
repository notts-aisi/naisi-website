/**
 * `courseExerciseResponses/{runId}__{uid}__{weekId}__{exerciseId}` — one
 * member's response to one weekly exercise. ALL writes go through server
 * routes (`allow write: if false` in rules): the response-type gate — a
 * "text" exercise must receive text, a "link" exercise a URL — compares the
 * submission against the exercise DEFINITION on the week doc, a cross-doc
 * check Firestore rules cannot express.
 *
 * The deterministic doc id makes one response per (run, member, week,
 * exercise) structural: the submit route upserts this exact path, so edits
 * replace rather than duplicate, and "editable until reviewed" is a status
 * check, not a query.
 *
 * Member content is plain text (`text`) or a validated URL (`linkUrl`) —
 * typed `string`, never `Block[]`, rendered as text nodes only. No rich
 * text, no uploads (locked product decision 7).
 */

export type ExerciseReviewStatus = "unreviewed" | "seen" | "needs-work" | "approved";

export const REVIEW_STATUSES: ExerciseReviewStatus[] = [
  "unreviewed",
  "seen",
  "needs-work",
  "approved",
];

export const REVIEW_STATUS_LABEL: Record<ExerciseReviewStatus, string> = {
  unreviewed: "Unreviewed",
  seen: "Seen",
  "needs-work": "Needs work",
  approved: "Approved",
};

/**
 * Length budgets for submissions + review feedback. The submit/review routes
 * are the security boundary; these power the client counters.
 */
export const EXERCISE_LIMITS = {
  responseText: 4000,
  linkUrl: 500,
  reviewerComment: 2000,
} as const;

export type CourseExerciseResponseDoc = {
  /** Firestore doc id: `exerciseResponseId(runId, uid, weekId, exerciseId)`. */
  id: string;
  runId: string;
  uid: string;
  /** Week doc id ("w03"), not a week number — stable across copy-forward. */
  weekId: string;
  exerciseId: string;
  /**
   * Asserted by the submit route against the exercise definition — stored so
   * the review queue renders without re-reading the week doc.
   */
  responseType: "text" | "link";
  /** Present iff responseType === "text". Plain text (see module comment). */
  text?: string;
  /** Present iff responseType === "link". Passed `validateSubmissionUrl`. */
  linkUrl?: string;
  submittedAt: Date | null;
  reviewStatus: ExerciseReviewStatus;
  /**
   * Singular by design — one facilitator owns a review verdict. Course code
   * deliberately never reuses the tasks vocabulary (`reviewerUids`).
   */
  reviewerUid?: string;
  /** Facilitator feedback shown to the member. */
  reviewerComment?: string;
  reviewedAt?: Date | null;
  updatedAt?: Date | null;
};

/**
 * Deterministic doc id — one response per (run, member, week, exercise),
 * structurally (see module comment). CONSTRUCT-ONLY — NEVER PARSE: every part
 * is stored as a field, and `__`-splitting is ambiguous because `slugId`-made
 * run ids already contain `__`.
 */
export function exerciseResponseId(
  runId: string,
  uid: string,
  weekId: string,
  exerciseId: string,
): string {
  return `${runId}__${uid}__${weekId}__${exerciseId}`;
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function normalizeExerciseResponse(
  id: string,
  data: Raw,
): CourseExerciseResponseDoc {
  const reviewStatus = data.reviewStatus as ExerciseReviewStatus;
  const doc: CourseExerciseResponseDoc = {
    id,
    runId: str(data.runId),
    uid: str(data.uid),
    weekId: str(data.weekId),
    exerciseId: str(data.exerciseId),
    responseType: data.responseType === "link" ? "link" : "text",
    submittedAt: tsToDate(data.submittedAt),
    reviewStatus: REVIEW_STATUSES.includes(reviewStatus) ? reviewStatus : "unreviewed",
    updatedAt: tsToDate(data.updatedAt),
  };
  if (typeof data.text === "string" && data.text) {
    doc.text = data.text;
  }
  if (typeof data.linkUrl === "string" && data.linkUrl) {
    doc.linkUrl = data.linkUrl;
  }
  if (typeof data.reviewerUid === "string" && data.reviewerUid) {
    doc.reviewerUid = data.reviewerUid;
  }
  if (typeof data.reviewerComment === "string" && data.reviewerComment) {
    doc.reviewerComment = data.reviewerComment;
  }
  const reviewedAt = tsToDate(data.reviewedAt);
  if (reviewedAt) doc.reviewedAt = reviewedAt;
  return doc;
}
