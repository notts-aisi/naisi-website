"use client";

import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import { CIRCULATION_LIMITS } from "@/lib/firestore/circulations";

/**
 * The one client-direct write staff make while reviewing: their notes and
 * scores on `circulations/{id}/reviews/{uid}`.
 *
 * IT IS CLIENT-DIRECT AND THE RETURN IS A ROUTE, and that split is the whole
 * access model in one line. A review is staff writing to a document only staff
 * can read, and `firestore.rules` expresses every invariant that matters about
 * it: who may write, which four keys may appear, the two size caps, and
 * `updatedByUid` pinned to the writer. Returning feedback crosses into a
 * document the recipient reads, which no rule can check the shape of, so that
 * is `POST .../responses/{uid}/return` and it is not in this file.
 *
 * ── WHY EVERY QUESTION IS WRITTEN, INCLUDING THE EMPTY ONES ─────────────────
 * `setDoc(..., { merge: true })` merges nested maps FIELD BY FIELD. Writing
 * `perQuestion` with an entry dropped therefore leaves the stored entry exactly
 * where it was: a reviewer who deleted what they had typed under question three
 * would see an empty box, and the return route would post the old sentence to
 * the recipient. So the caller hands over an entry for every question it is
 * showing, empty ones included, and this function writes them all. The stored
 * map is then always what the boxes say, and merge semantics stop mattering.
 * `normalizeReview` drops the empty entries on the way back out, so nothing
 * downstream has to know they were written.
 *
 * Merge rather than a whole-document set for the other half of the same
 * reason: two reviewers on one response would otherwise overwrite each other's
 * `overall` with a stale copy on every keystroke. Last write wins per field is
 * the honest behaviour for a shared document with no lock, and the panel says
 * so.
 *
 * ── NO `undefined`, EVER ────────────────────────────────────────────────────
 * A client-direct write refuses an explicit undefined outright, nested ones
 * included, so a cleared score is written as `null` and a cleared box as `""`.
 */

/**
 * One question's entry as the panel holds it. `score` is a number or null
 * rather than an optional, because "cleared" has to be writable and an absent
 * key cannot clear anything under merge (see above).
 */
export type ReviewEntryDraft = { feedback: string; score: number | null };

export type ReviewDraft = {
  /** Keyed by question id. One entry per question the panel is showing. */
  perQuestion: Record<string, ReviewEntryDraft>;
  overall: string;
};

/** Whole number inside the score band, or null for anything that is not one. */
function clampScore(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(
    Math.max(Math.round(value), CIRCULATION_LIMITS.scoreMin),
    CIRCULATION_LIMITS.scoreMax,
  );
}

/**
 * Save one response's review.
 *
 * The WRITER is read from the auth client rather than taken as an argument:
 * the rules pin `updatedByUid == request.auth.uid`, so a caller-supplied uid
 * could only ever agree with this one or be refused, and a refused write that
 * looks like a caller mistake is harder to read than no choice at all. A review
 * is the record of a judgement about a person, and the name on it is quoted
 * back to them when it is returned.
 */
export async function saveReview(
  circulationId: string,
  responseUid: string,
  draft: ReviewDraft,
): Promise<void> {
  const db = getClientDb();
  const writerUid = getClientAuth().currentUser?.uid;
  if (!writerUid) throw new Error("Not signed in");

  const perQuestion: Record<string, { feedback: string; score: number | null }> = {};
  for (const [questionId, entry] of Object.entries(draft.perQuestion)) {
    perQuestion[questionId] = {
      // Capped here as well as in the box, because the cap the rules CAN'T
      // express is this one: they bound how many entries the map has, never how
      // long one of them is.
      feedback: (entry.feedback ?? "").slice(0, CIRCULATION_LIMITS.feedback),
      score: clampScore(entry.score ?? null),
    };
  }

  await setDoc(
    doc(db, "circulations", circulationId, "reviews", responseUid),
    {
      perQuestion,
      overall: (draft.overall ?? "").slice(0, CIRCULATION_LIMITS.overall),
      updatedAt: serverTimestamp(),
      updatedByUid: writerUid,
    },
    { merge: true },
  );
}
