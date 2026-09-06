"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeReview, type ReviewDoc } from "@/lib/firestore/circulations";

/**
 * One recipient's review document, live: the staff notes and scores about
 * their answers.
 *
 * A STAFF-ONLY READ, and `firestore.rules` is what makes that true rather than
 * anything here: `circulations/{id}/reviews/{uid}` admits admins and the parent
 * circulation's staff and nobody else, so a recipient attaching this listener
 * gets permission-denied rather than an empty document. The panel that uses it
 * is only rendered for staff, so passing null is how a non-staff surface holds
 * the hook rather than a branch inside it.
 *
 * A GET of an addressed path, never a list. The subcollection is never listed
 * by anything: staff read one review at a time, beside the response it is
 * about, and a list would be a way to page through every judgement on a
 * circulation at once.
 *
 * `review` is null when nothing has been written yet, which is the ordinary
 * case rather than an error: the document is created by the first save. The
 * caller distinguishes "not loaded" from "nothing there" with `loading`, which
 * matters because hydrating an editor's boxes from a null that has not
 * finished arriving would blank what somebody had already typed.
 *
 * ── WHAT ARRIVED IS STAMPED WITH WHOSE REVIEW IT IS ─────────────────────────
 * The snapshot is stored WITH the `circulationId/uid` it answers, and the
 * getters below hand back nothing until that stamp matches the arguments this
 * render was called with. Resetting inside the effect instead would be a frame
 * too late: props change during render, effects run after it, and a caller that
 * seeds its boxes during render (ReviewPanel does, so a reviewer never sees one
 * frame of empty boxes over feedback that has already arrived) would seed the
 * PREVIOUS recipient's feedback into the next recipient's boxes and then write
 * it to their document on the next keystroke. Deriving the answer from the
 * stamp closes that window by construction rather than by remembering to reset.
 */
export function useReview(circulationId: string | null, uid: string | null) {
  /** Null when the caller is holding the hook without a subject. */
  const key = circulationId && uid ? `${circulationId}/${uid}` : null;

  /**
   * The last thing the listener said, and which subject it was about. One
   * state rather than three, because "this review, or this refusal, for this
   * key" has to move as one value: a review from A beside an error from B is a
   * state no reader could make sense of.
   */
  const [arrived, setArrived] = useState<{
    key: string;
    review: ReviewDoc | null;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    if (!circulationId || !uid) return;
    const subject = `${circulationId}/${uid}`;
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "circulations", circulationId, "reviews", uid),
      (snap) => {
        setArrived({
          key: subject,
          review: snap.exists() ? normalizeReview(snap.id, snap.data()) : null,
          error: null,
        });
      },
      // Never swallowed. A refusal here means the viewer is not staff of this
      // circulation, and a panel that showed empty boxes instead would invite
      // somebody to type feedback into a document they cannot write.
      (err) => {
        console.error("useReview:", err);
        setArrived({ key: subject, review: null, error: err });
      },
    );
    return unsub;
  }, [circulationId, uid]);

  const current = arrived && arrived.key === key ? arrived : null;
  return {
    review: current?.review ?? null,
    // Loading until this subject's own snapshot has landed. A hook held with
    // no subject is not loading: there is nothing on the way.
    loading: key !== null && current === null,
    error: current?.error ?? null,
  };
}
