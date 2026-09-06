"use client";

/**
 * WAVE 2 LANDS HERE. Renders nothing, on purpose.
 *
 * Reviewing is per-question feedback, per-question scoring and one overall
 * box, written client-direct to `circulations/{id}/reviews/{uid}` and then
 * copied onto the response by the return route. None of that exists yet. What
 * exists is the SHAPE of the read-only view it has to slot into, and this
 * component marks the two places it goes: under each answer, and once at the
 * end. Naming them now means the wave that builds the review UI edits one file
 * and moves nothing else, rather than re-deciding the layout of a page people
 * are already using.
 *
 * A component rather than a TODO comment, because a comment cannot be typed.
 * The props are the ones the real thing will need, so a wave-2 implementation
 * that wants something else has to change every callsite, which is the
 * conversation worth forcing.
 */

type Props = {
  /** Which box: one per question, or the single overall one. */
  scope: "question" | "overall";
  /** Present when `scope` is "question". */
  questionId?: string;
  /** The response being reviewed. Its doc id is the recipient's uid. */
  responseUid: string;
  circulationId: string;
};

export default function ReviewSlot(_props: Props) {
  return null;
}
