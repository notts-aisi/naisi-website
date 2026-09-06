"use client";

import { useEffect, useRef } from "react";
import { doc, increment, serverTimestamp, updateDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  CIRCULATIONS_COLLECTION,
  RESPONSES_SUBCOLLECTION,
  type ResponseDoc,
} from "@/lib/firestore/circulations";

/**
 * The activity the recipient's own client stamps on their response: when they
 * first opened it, how many pages they have opened, and roughly how long they
 * have spent with it in front of them.
 *
 * ── WHAT IS DELIBERATELY NOT MEASURED ───────────────────────────────────────
 * No keystrokes, no paste events, no per-question timing, nothing that could
 * reconstruct how somebody worked. Three coarse numbers, shown to the staff on
 * the circulation page AND back to the recipient on this very page and on
 * their task, because a measurement somebody cannot see is a measurement they
 * did not agree to. The privacy notice carries a line for it.
 *
 * ── WHY THE TIMER TESTS TWO THINGS ──────────────────────────────────────────
 * `activeMs` adds a tick only when the tab is VISIBLE and the person has moved
 * or typed in the last minute. Either test alone measures the wrong thing: a
 * visible tab left open over lunch would bank an hour nobody spent, and an
 * input test alone would keep counting in a background tab where a stray
 * pointer event still fires. Together they answer "was this worksheet in front
 * of a working person", which is the only question the number is asked.
 *
 * ── EVERY WRITE IS BEST-EFFORT ──────────────────────────────────────────────
 * These are all client-direct updates on the response, allowed by the same
 * narrow rule as the autosave. A refusal (the response was frozen a moment
 * ago, the session expired) is logged and swallowed: activity is telemetry
 * about the work, and it must never stand between somebody and the work
 * itself. The one write that matters, the answers, has its own error surface.
 */

/** How often the ticker fires, and what one tick is worth. */
const TICK_MS = 30_000;
/** A pointer or key event older than this means they have wandered off. */
const RECENT_INPUT_MS = 60_000;

function logRefusal(what: string, err: unknown): void {
  // Not surfaced to the recipient: see the module comment.
  console.warn(`[worksheet] activity write refused (${what})`, err);
}

export function useResponseActivity(args: {
  circulationId: string;
  /** Null until auth resolves. */
  uid: string | null;
  /** The live response, or null while it loads or when it is not readable. */
  response: ResponseDoc | null;
  /** The page the recipient is looking at. */
  pageIndex: number;
  /** False once the response is frozen: nothing is stamped after submission. */
  enabled: boolean;
}): void {
  const { circulationId, uid, response, pageIndex, enabled } = args;

  const ready = Boolean(uid && response && enabled);
  const taskId = response?.taskId ?? null;
  const alreadyOpened = response?.activity.firstOpenedAt != null;

  /**
   * The page index this mount has already counted. Null until the first
   * stamp, which is how "arriving on the worksheet" and "moving to page 2"
   * are told apart without a second effect that could double count.
   */
  const stampedPageRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ready || !uid) return;
    if (stampedPageRef.current === pageIndex) return;
    const firstEver = stampedPageRef.current === null && !alreadyOpened;
    // Claimed BEFORE the await so a re-render mid-flight cannot fire a second
    // write for the same page.
    stampedPageRef.current = pageIndex;

    const db = getClientDb();
    const ref = doc(
      db,
      CIRCULATIONS_COLLECTION,
      circulationId,
      RESPONSES_SUBCOLLECTION,
      uid,
    );

    if (firstEver) {
      // ONE write, not three: the stamp, the first page open and the move out
      // of `not-opened` are the same event, and splitting them would leave a
      // response that had been opened but not started if the second failed.
      updateDoc(ref, {
        "activity.firstOpenedAt": serverTimestamp(),
        "activity.pageOpens": increment(1),
        "activity.lastActiveAt": serverTimestamp(),
        state: "started",
        updatedAt: serverTimestamp(),
      }).catch((err) => logRefusal("first open", err));

      // The task moves with it, so the board says "in progress" the moment
      // somebody opens their worksheet rather than only when they submit. A
      // separate write because it is a different document in a different
      // collection: there is no client-side transaction that spans them, and
      // the response is the authority either way (the submit, return and
      // unfreeze routes all re-derive the task's status from it).
      if (taskId) {
        updateDoc(doc(db, "tasks", taskId), {
          status: "in-progress",
          updatedAt: serverTimestamp(),
        }).catch((err) => logRefusal("task status", err));
      }
      return;
    }

    updateDoc(ref, {
      "activity.pageOpens": increment(1),
      "activity.lastActiveAt": serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).catch((err) => logRefusal("page open", err));
  }, [ready, uid, circulationId, pageIndex, alreadyOpened, taskId]);

  /**
   * When this person last moved or typed. Zero rather than `Date.now()` here:
   * a clock read during render is impure (the lint rule is right, two renders
   * would disagree), and the effect below seeds it the moment the ticker
   * starts. Seeded to "now" there rather than to zero, because opening the
   * page is itself a sign of life and the first tick should count rather than
   * wait for a mouse to move.
   */
  const lastInputRef = useRef<number>(0);

  useEffect(() => {
    if (!ready || !uid) return;

    lastInputRef.current = Date.now();
    const noteInput = () => {
      lastInputRef.current = Date.now();
    };
    // Passive, and on the window rather than the form: a recipient reading a
    // long question scrolls and moves the pointer without touching a field,
    // and that is still time spent on the worksheet.
    window.addEventListener("pointerdown", noteInput, { passive: true });
    window.addEventListener("pointermove", noteInput, { passive: true });
    window.addEventListener("keydown", noteInput, { passive: true });

    const db = getClientDb();
    const ref = doc(
      db,
      CIRCULATIONS_COLLECTION,
      circulationId,
      RESPONSES_SUBCOLLECTION,
      uid,
    );

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInputRef.current > RECENT_INPUT_MS) return;
      updateDoc(ref, {
        "activity.activeMs": increment(TICK_MS),
        "activity.lastActiveAt": serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch((err) => logRefusal("active time", err));
    }, TICK_MS);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", noteInput);
      window.removeEventListener("pointermove", noteInput);
      window.removeEventListener("keydown", noteInput);
    };
  }, [ready, uid, circulationId]);
}

export default useResponseActivity;
