/**
 * `admissionReviews/{roundId}__{applicantUid}__{reviewerUid}` — one
 * reviewer's scored assessment of one applicant.
 *
 * ## The doc id is the "no duplicates" rule
 *
 * Deterministic and CONSTRUCT-ONLY: one row per reviewer per applicant, so a
 * second submit is an UPDATE and never a duplicate. Aggregates (mean, spread,
 * coverage) are computed from these rows at read time and are stored nowhere,
 * which is what makes a re-score correct without a recount step.
 *
 * `roundId` is in the id as well as in a field because the review queue and
 * the coverage filters both page by round; the fields are what the queries
 * read, and the id is never parsed back apart.
 *
 * ## Routes-only, read:false as well as write:false
 *
 * `allow read, write: if false`, and the read half is not defence in depth.
 * An own-row read would let any reviewer enumerate who scored whom and how,
 * which is exactly the correlation a name-blind process exists to prevent,
 * and a list of one applicant's rows reveals a disagreement the queue
 * deliberately shows only as a spread.
 *
 * The route is what enforces the three rules rules cannot:
 *
 *  - the SELF-REVIEW guard (`applicantUid === reviewerUid` is a 403, and the
 *    queue also filters the caller's own application out as a second layer);
 *  - membership of `round.reviewerUids`, which is a cross-document check;
 *  - `total`, which is RECOMPUTED server-side from `scores` and the round's
 *    scale, ignoring whatever the client sent. A stored total a client can
 *    write is a ranking a client can write.
 *
 * ## Reviewer notes are disclosable
 *
 * Everything written here is part of the applicant's record and can be
 * disclosed to them on request. The review queue says so, in those words,
 * above the notes field. That is a reason to write carefully, not a reason to
 * hide the field.
 */

/** What a reviewer recommends, separately from the scores. */
export type ReviewRecommendation = "advance" | "hold" | "decline";

export const REVIEW_RECOMMENDATIONS: ReviewRecommendation[] = [
  "advance",
  "hold",
  "decline",
];

export const REVIEW_RECOMMENDATION_LABEL: Record<ReviewRecommendation, string> = {
  advance: "Advance",
  hold: "Hold",
  decline: "Decline",
};

/**
 * The routes are the security boundary; these power the scoring panel's
 * counters. `maxCriteria` mirrors `ADMISSION_ROUND_FIELD_LIMITS.maxCriteria`
 * deliberately rather than importing it: a review row must stay readable if a
 * round's criteria list is later trimmed, so the cap here is about the stored
 * map, not about the round.
 */
export const ADMISSION_REVIEW_FIELD_LIMITS = {
  notes: 4000,
  maxCriteria: 10,
} as const;

export type AdmissionReviewDoc = {
  /** Firestore doc id: `admissionReviewId(roundId, applicantUid, reviewerUid)`. */
  id: string;
  roundId: string;
  applicantUid: string;
  reviewerUid: string;
  /** Score per `round.criteria[].id`. Unscored criteria are simply absent. */
  scores: Record<string, number>;
  /**
   * The sum of `scores`, RECOMPUTED server-side on every write. Denormalised
   * only so the queue can sort without reading every criterion; it is never
   * trusted from a client and never read as the authority when the two
   * disagree.
   */
  total: number;
  recommendation: ReviewRecommendation | null;
  /** Free text. Disclosable to the applicant on request; the queue says so. */
  notes: string;
  /**
   * The required "I know this applicant" declaration. Not a block: knowing a
   * candidate is normal in a society this size, and pretending otherwise
   * would just move the fact off the record. It surfaces to the final
   * decider next to the score.
   */
  knowsApplicant: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

/**
 * Deterministic doc id: one row per (round, applicant, reviewer).
 * CONSTRUCT-ONLY (see the module comment).
 */
export function admissionReviewId(
  roundId: string,
  applicantUid: string,
  reviewerUid: string,
): string {
  return `${roundId}__${applicantUid}__${reviewerUid}`;
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max?: number): string {
  const s = typeof v === "string" ? v : "";
  return max === undefined ? s : s.slice(0, max);
}

function asScores(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  let kept = 0;
  for (const [criterionId, score] of Object.entries(v as Raw)) {
    if (kept >= ADMISSION_REVIEW_FIELD_LIMITS.maxCriteria) break;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    out[criterionId] = score;
    kept += 1;
  }
  return out;
}

/**
 * The sum a route writes into `total`. Exported so the route, the queue's
 * drift check and the tests all use one arithmetic, rather than three that
 * agree today.
 */
export function reviewTotal(scores: Record<string, number>): number {
  let total = 0;
  for (const score of Object.values(scores)) {
    if (typeof score === "number" && Number.isFinite(score)) total += score;
  }
  return total;
}

export function normalizeAdmissionReview(id: string, data: Raw): AdmissionReviewDoc {
  const recommendation = data.recommendation as ReviewRecommendation;
  const scores = asScores(data.scores);
  return {
    id,
    roundId: str(data.roundId),
    applicantUid: str(data.applicantUid),
    reviewerUid: str(data.reviewerUid),
    scores,
    // A stored total that disagrees with the stored scores is a row somebody
    // reached around the route to write, so the scores win on read.
    total: reviewTotal(scores),
    recommendation: REVIEW_RECOMMENDATIONS.includes(recommendation)
      ? recommendation
      : null,
    notes: str(data.notes, ADMISSION_REVIEW_FIELD_LIMITS.notes),
    knowsApplicant: data.knowsApplicant === true,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}
