/**
 * `admissionApplicationPrivate/{roundId}__{uid}`: the access-requirements
 * answer, and NOTHING else.
 *
 * ## Why this is a collection and not a field
 *
 * The form asks "is there anything we should know about access requirements?"
 * In practice that answer will contain disability and health information: it
 * is the most sensitive text the whole intake collects, and the owner's rule
 * is that it is never scored.
 *
 * A field on the application row could deliver that promise only by every
 * reader remembering to strip it. The reviewer queue payload, the decisions
 * aggregate, the applications CSV export, the evidence recompute and whatever
 * gets written next would each have to remember, separately, forever. One
 * forgotten `...application` spread and the answer is in a reviewer's browser
 * or a spreadsheet on somebody's laptop.
 *
 * Putting it in its own collection makes the property STRUCTURAL. The export
 * route never joins this collection, so no column of the CSV can carry the
 * answer; the queue never joins it, so no blind reviewer can be handed it.
 * There is exactly one reader,
 * `GET /api/admissions/rounds/[roundId]/applications/[uid]/private`, gated to
 * the final decider and admins, and every read of it appends a `courseAudit`
 * row with kind `access-requirements-read`.
 *
 * ## Why the id is shared with the application
 *
 * `${roundId}__${uid}`, byte-identical to `admissionApplicationId`. That is
 * not tidiness: it makes both the destroy cascade and the account-deletion
 * sweep ADDRESSED deletes rather than queries, which matters because this
 * document deliberately carries no `uid` field to query on. The cost is a
 * real ordering dependency, and `accountDeletion.ts` enforces it in code
 * rather than by comment: the applications are the only index back to these
 * ids, so the private rows go in the SAME batch that deletes them.
 *
 * `allow read, write: if false`, obviously.
 */

/** Long enough for a real answer; short enough that nobody pastes a document. */
export const ADMISSION_PRIVATE_FIELD_LIMITS = {
  accessRequirements: 1500,
} as const;

export type AdmissionApplicationPrivateDoc = {
  /** Firestore doc id: `admissionApplicationPrivateId(roundId, uid)`. */
  id: string;
  /**
   * The applicant's free-text answer. The ONLY field. Adding a second one
   * starts the "which readers have to remember to strip this" problem the
   * collection exists to end, so if something else needs storing it wants its
   * own home, not this one.
   */
  accessRequirements: string;
};

type Raw = Record<string, unknown>;

export function normalizeAdmissionApplicationPrivate(
  id: string,
  data: Raw,
): AdmissionApplicationPrivateDoc {
  const raw = data?.accessRequirements;
  return {
    id,
    accessRequirements:
      typeof raw === "string"
        ? raw.slice(0, ADMISSION_PRIVATE_FIELD_LIMITS.accessRequirements)
        : "",
  };
}
