"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Chip, { type ChipTone } from "@/components/ui/Chip";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Input } from "@/components/ui/Input";
import MemberName from "@/components/ui/MemberName";
import MemberText from "@/components/ui/MemberText";
import SavedFlash from "@/components/ui/SavedFlash";
import { useDebouncedWrite } from "@/hooks/useDebouncedWrite";
import {
  EXERCISE_LIMITS,
  REVIEW_STATUS_LABEL,
  type ExerciseReviewStatus,
} from "@/lib/firestore/courseExercises";
import { validateSubmissionUrl, type Exercise } from "@/lib/firestore/courses";
import type { ExerciseResponseWire } from "@/app/api/courses/runs/[runId]/exercises/[exerciseId]/submit/route";
import styles from "./ExerciseSubmit.module.css";

/**
 * One weekly exercise, from the member's side: the answer field, the 900ms
 * autosave, the explicit "Submit for review", and — once a facilitator has
 * ruled on it — the verdict, the feedback, and the locked field.
 *
 * ── THE TWO WRITES ──────────────────────────────────────────────────────────
 * Both go to the same route; `submit` is the only difference.
 *   autosave  POST … { submit: false }  — a draft. Debounced 900ms, flushed on
 *             blur and on unmount, feedback INLINE via SavedFlash (house rule:
 *             keep-working feedback never takes a toast).
 *   submit    POST … { submit: true }   — "I'm done", stamps `submittedAt`.
 * A submitted answer stays editable: submitting is a signal to the facilitator,
 * not a lock. The lock is the REVIEW.
 *
 * ── WHY THE SUBMIT MAY WRITE OUTSIDE THE AUTOSAVE QUEUE ─────────────────────
 * `useDebouncedWrite` is a single-writer queue: two autosaves can never overlap
 * or land out of order. The submit posts OUTSIDE that queue, which is only safe
 * because three things hold together, all of them load-bearing:
 *   1. it `flush()`es first, so any pending draft has already landed and the
 *      queue is empty and timer-less when the submit is dispatched;
 *   2. the field is `readOnly` for the whole round trip, so nothing can push a
 *      new value in behind the submit's back;
 *   3. it reads the value AT DISPATCH TIME (`valueRef`), never from the click's
 *      render closure.
 * Drop any one of them and the older value wins the race: flush sends V1, the
 * member adds a sentence during the round trip (V2 goes out and lands), and the
 * click-closure V1 then lands last — document holding V1, box showing V2, no
 * error, nothing scheduled to converge. THE INVARIANT: the last write to land is
 * always the value the member last saw.
 *
 * ── EDITABLE UNTIL REVIEWED ─────────────────────────────────────────────────
 * `reviewStatus !== "unreviewed"` means a facilitator has read this and put a
 * verdict on it. Editing then would silently invalidate that verdict, so the
 * field goes read-only and the copy says who can undo it. This is a UI gate;
 * the submit route enforces the same rule, which is the boundary.
 *
 * The boundary can win a race: a facilitator reviewing the answer WHILE it is
 * open here turns the next autosave into a 409. That refusal is not swallowed —
 * the route's sentence is shown, the field freezes (`readOnly`, not replaced,
 * so an unsaved paragraph stays on screen to be copied), and the Submit button
 * goes with it. Nothing further is scheduled once that happens.
 *
 * ── WHAT THE WRITER SENDS IS WHAT THE BOX SHOWS ─────────────────────────────
 * Every keystroke either PUSHES the value now in the box or CANCELS the
 * scheduled write. Returning early without cancelling — which is what "don't
 * save a half-typed URL" and "don't write an empty doc" used to do — leaves the
 * PREVIOUS keystroke's value queued, and 900ms later it lands: box empty,
 * document holding the deleted sentence, SavedFlash saying "Saved". There is no
 * third option in `handleChange`.
 *
 * Cancelling instead of pushing is right in exactly ONE case — an emptied box
 * with nothing to clear — and "nothing to clear" has to mean nothing stored AND
 * nothing on the wire. `storedValue` only knows what the SERVER has echoed back,
 * so a write dispatched a moment ago still reads as "nothing stored";
 * `dispatchedRef` is the other half of the test, and without it the very first
 * answer, deleted while its own autosave was in flight, stays in the document
 * (and in the facilitator's queue) under a "Saved" flash.
 *
 * ── RENDERING MEMBER + STAFF STRINGS ────────────────────────────────────────
 * The member's own answer and the facilitator's feedback are BOTH plain
 * `string` on the wire (see courseExercises.ts) and both render through
 * MemberText — text nodes, no markup, no linkification. Facilitator feedback is
 * staff prose, but staff prose that arrived as a plain string: the repo's rich
 * renderer (features/tasks RichTextRender) renders TipTap blocks and has no
 * business being pointed at a string. If courses ever grow block-authored
 * feedback, that is a data-model change and this is where it surfaces.
 *
 * A submitted LINK renders as text too, deliberately — MemberText's no-anchor
 * rule is the whole reason the XSS surface here is closed, and the member
 * pasted the URL themselves so they lose nothing by copying it back out.
 */

type Props = {
  runId: string;
  /** Week DOC id ("w03"), not the number — what the submit route addresses. */
  weekId: string;
  /** The taught-week number, for labelling only. */
  weekNumber: number;
  exercise: Exercise;
  /** The member's stored row, or null before they have written anything. */
  response: ExerciseResponseWire | null;
  /** Hand back the row the route returned; the caller merges it. */
  onSaved: (response: ExerciseResponseWire) => void;
  /**
   * Show the stored answer without any inputs. For a viewer whose learner
   * enrolment is no longer active (a completed run is their own history —
   * readable, not writable). The reviewed lock below is separate and applies
   * whatever this says.
   */
  readOnly?: boolean;
};

const STATUS_TONE: Record<ExerciseReviewStatus, ChipTone> = {
  unreviewed: "neutral",
  seen: "accent",
  "needs-work": "warning",
  approved: "success",
};

const LINK_HINT =
  "Paste a link to a Google Doc, a Colab notebook, or anything else your facilitator can open.";

/** Never rendered on the server (the page fetches first), so locale is safe. */
function submittedLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * A refusal that still knows which one it was. The status matters to the
 * caller: 409 is not "try again", it is "a facilitator has this now", and the
 * autosave path has to be able to tell the two apart from inside
 * `useDebouncedWrite`'s error slot.
 */
class SubmissionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SubmissionError";
    this.status = status;
  }
}

async function postSubmission(args: {
  runId: string;
  exerciseId: string;
  weekId: string;
  responseType: "text" | "link";
  value: string;
  submit: boolean;
  /** Set on the unmount / page-hide autosave so the request outlives the page. */
  keepalive?: boolean;
}): Promise<ExerciseResponseWire> {
  const res = await fetch(
    `/api/courses/runs/${encodeURIComponent(args.runId)}/exercises/${encodeURIComponent(
      args.exerciseId,
    )}/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        weekId: args.weekId,
        ...(args.responseType === "link"
          ? { linkUrl: args.value }
          : { text: args.value }),
        submit: args.submit,
      }),
      // Answers are capped at 4000 characters, an order of magnitude under the
      // browser's 64KB keepalive budget.
      keepalive: args.keepalive === true,
    },
  );
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; response?: ExerciseResponseWire; error?: string }
    | null;
  if (!res.ok || !body?.response) {
    throw new SubmissionError(
      body?.error ?? `Couldn't save your answer (${res.status}).`,
      res.status,
    );
  }
  return body.response;
}

export default function ExerciseSubmit({
  runId,
  weekId,
  weekNumber,
  exercise,
  response,
  onSaved,
  readOnly = false,
}: Props) {
  const fieldId = useId();
  const isLink = exercise.responseType === "link";

  const stored = response;
  const storedValue = stored ? (isLink ? (stored.linkUrl ?? "") : (stored.text ?? "")) : "";

  const [value, setValue] = useState(storedValue);
  const [touched, setTouched] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(stored?.id ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * The value as it is NOW, for the submit to read when it dispatches rather
   * than when it was clicked (see the module comment). Mirrored in an effect —
   * React flushes passive effects before the next discrete event, so a click
   * handler always reads the value the member is looking at.
   */
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  /**
   * Has an autosave ever gone ON THE WIRE this session? Set as the write is
   * dispatched, never reset: from that moment an emptied box is an edit worth
   * writing even though `storedValue` — the last row the server echoed — may
   * still say nothing is stored. The submit path doesn't set it because it
   * updates `stored` itself when it succeeds, and leaves nothing to clear when
   * it fails.
   */
  const dispatchedRef = useRef(false);

  // Render-phase adjustment (MaterialExtras' idiom, no effect): if the stored
  // row arrives after mount, seed the field from it — but never once the member
  // has typed, so a late fetch cannot clobber a draft in progress.
  if (stored && seededId !== stored.id && !touched) {
    setSeededId(stored.id);
    setValue(storedValue);
  }

  // A verdict locks the answer; the enrolment being over locks it too.
  const reviewed = stored !== null && stored.reviewStatus !== "unreviewed";
  const locked = reviewed || readOnly;

  // Client-side mirror of the route's `validateSubmissionUrl` — same function,
  // so the inline error and the refusal say the same thing. Blank is not an
  // error while typing; it is just nothing to save yet.
  const trimmed = value.trim();
  const urlError =
    isLink && trimmed ? validateSubmissionUrl(trimmed, EXERCISE_LIMITS.linkUrl) : null;

  const maxLength = Math.min(
    Math.max(1, exercise.maxLength || EXERCISE_LIMITS.responseText),
    EXERCISE_LIMITS.responseText,
  );

  const autosave = useCallback(
    async (draft: string, opts: { keepalive: boolean }) => {
      // Marked here, at the moment the request goes out — see `dispatchedRef`.
      dispatchedRef.current = true;
      const saved = await postSubmission({
        runId,
        exerciseId: exercise.id,
        weekId,
        responseType: exercise.responseType,
        value: draft,
        submit: false,
        keepalive: opts.keepalive,
      });
      onSaved(saved);
    },
    [exercise.id, exercise.responseType, onSaved, runId, weekId],
  );

  const saver = useDebouncedWrite(autosave);

  // The route refused the last autosave because a facilitator got there first
  // (see the module comment). `onSaved` never fired, so `stored.reviewStatus`
  // still reads "unreviewed" locally — this, not the row, is what knows.
  const conflict =
    saver.error instanceof SubmissionError && saver.error.status === 409;
  /** Nothing may be written any more, by either path. */
  const frozen = locked || conflict;
  /**
   * The input freezes for two unrelated reasons, and neither one empties it: a
   * 409 (permanently, see above) and an in-flight submit (for the round trip
   * only, so the write that is travelling stays the one the box shows).
   */
  const fieldReadOnly = conflict || submitting;

  const cancelPending = saver.cancel;
  useEffect(() => {
    // A value queued behind the refused write would go out and be refused
    // again, restating an error the member is already reading.
    if (conflict) cancelPending();
  }, [conflict, cancelPending]);

  const handleChange = (next: string) => {
    setTouched(true);
    setValue(next);
    // Every branch below either pushes or cancels — see the module comment.
    // `submitting` is included so the "nothing enters the queue behind a
    // submit" property survives any future writer of `value` that is not the
    // read-only field itself (a Clear button, a paste helper).
    if (frozen || submitting) {
      cancelPending();
      return;
    }
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
      // Emptying the box IS an edit when something is stored — the route
      // treats an empty autosave as "still an empty draft" and clears the
      // field, so the screen and the document stay in step. With nothing
      // stored there is nothing to clear (writing an empty doc for a field
      // somebody merely clicked into is noise) — but the previous keystroke's
      // write is still scheduled, and it holds text this box no longer shows.
      //
      // `dispatchedRef` covers the gap `storedValue` cannot see: a write
      // already on the wire has not echoed back yet, so "nothing stored" is
      // not the same question as "nothing written".
      if (storedValue || dispatchedRef.current) saver.push("");
      else cancelPending();
      return;
    }
    if (isLink) {
      // A half-typed URL is never pushed: the route validates with the same
      // function, so sending one would only produce a sticky error mid-word.
      // Cancelling is the other half of that rule — an edit that INVALIDATES a
      // URL must unschedule the older valid one too, or blur flushes a link
      // that differs from the one on screen under a "Saved" flash.
      if (validateSubmissionUrl(nextTrimmed, EXERCISE_LIMITS.linkUrl)) {
        cancelPending();
        return;
      }
      saver.push(nextTrimmed);
      return;
    }
    saver.push(next);
  };

  /**
   * Why a submit would be refused, in the route's own words — the same rules
   * the route applies, run against WHATEVER value is about to be sent. It is
   * called twice: once on the click, so a refusal costs no request, and once at
   * dispatch, because that is the value that actually travels.
   */
  const submitRefusal = (candidate: string): string | null => {
    const t = candidate.trim();
    if (!t) {
      return isLink ? "Please enter a link." : "Please write an answer before submitting.";
    }
    return isLink ? validateSubmissionUrl(t, EXERCISE_LIMITS.linkUrl) : null;
  };

  const handleSubmit = async () => {
    if (frozen || submitting) return;
    const clickRefusal = submitRefusal(value);
    if (clickRefusal) {
      setSubmitError(clickRefusal);
      return;
    }
    setSubmitError(null);
    // Freezes the field for the whole round trip (see the module comment): with
    // no way to type, nothing can be pushed into the autosave queue behind this
    // write, and the box cannot end up showing a sentence the server never got.
    setSubmitting(true);
    try {
      // Land the pending draft first — otherwise its 900ms timer could fire
      // after this and overwrite the submitted row with an older value. This
      // also leaves the queue empty and the timer stopped, which is what lets
      // the post below leave the queue at all.
      await saver.flush();
      // The value AS IT IS NOW, not as the click closure captured it.
      const current = valueRef.current;
      const refusal = submitRefusal(current);
      if (refusal) {
        setSubmitError(refusal);
        return;
      }
      const saved = await postSubmission({
        runId,
        exerciseId: exercise.id,
        weekId,
        responseType: exercise.responseType,
        value: isLink ? current.trim() : current,
        submit: true,
      });
      onSaved(saved);
      // The value IS stored now, by this path. A standing autosave error would
      // otherwise sit beside the button saying it isn't — sticky by design, and
      // wrong from the moment this line runs.
      saver.reset();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Couldn't submit your answer.");
    } finally {
      setSubmitting(false);
    }
  };

  const submittedOn = submittedLabel(stored?.submittedAt ?? null);
  const hasSubmitted = stored !== null && stored.submittedAt !== null;
  // ONE condition, used for both the element and the idref that points at it:
  // spelled twice they drift, and an `aria-describedby` naming an id that isn't
  // in the document describes nothing.
  const showHint = isLink && !locked && !urlError;
  const describedBy = [
    showHint ? `${fieldId}-hint` : "",
    urlError || submitError ? `${fieldId}-error` : "",
  ]
    .filter(Boolean)
    .join(" ");
  /** The route's own sentence for a failed autosave — never only the generic one. */
  const saveError = saver.state === "error" ? saver.error : null;

  return (
    <div className={styles.root} role="group" aria-label={`Your answer — week ${weekNumber}`}>
      <div className={styles.status}>
        {hasSubmitted ? (
          <Chip tone={STATUS_TONE[stored.reviewStatus]} size="sm">
            {REVIEW_STATUS_LABEL[stored.reviewStatus]}
          </Chip>
        ) : (
          exercise.required && <span className={styles.required}>Required</span>
        )}
        {submittedOn && <span className={styles.stamp}>Submitted {submittedOn}</span>}
      </div>

      {locked ? (
        <div className={styles.answerBlock}>
          <p className={styles.label}>Your answer</p>
          {storedValue ? (
            // Plain text, never an anchor — see the module comment.
            <MemberText text={storedValue} className={styles.answer} />
          ) : (
            <p className={styles.quiet}>You didn&apos;t submit an answer to this one.</p>
          )}
          <p className={styles.lockNote}>
            {reviewed
              ? "Your facilitator has reviewed this — ask them to reopen it if you need to change your answer."
              : "This cohort has finished, so your answers are read-only now."}
          </p>
        </div>
      ) : (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-input`}>
            {isLink ? "Link to your work" : "Your answer"}
          </label>
          {isLink ? (
            <Input
              id={`${fieldId}-input`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…"
              maxLength={EXERCISE_LIMITS.linkUrl}
              value={value}
              // Frozen by the route (or by a submit in flight), not emptied:
              // what they were writing stays on screen (and selectable) instead
              // of vanishing behind a lock.
              readOnly={fieldReadOnly}
              aria-invalid={urlError ? true : undefined}
              aria-describedby={describedBy || undefined}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={() => void saver.flush()}
            />
          ) : (
            <CountedTextarea
              id={`${fieldId}-input`}
              rows={5}
              value={value}
              max={maxLength}
              readOnly={fieldReadOnly}
              placeholder="Write your answer here — it saves as you type."
              aria-describedby={describedBy || undefined}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={() => void saver.flush()}
            />
          )}
          {showHint && (
            <p className={styles.hint} id={`${fieldId}-hint`}>
              {LINK_HINT}
            </p>
          )}
          {(urlError || submitError) && (
            <p className={styles.error} id={`${fieldId}-error`}>
              {urlError ?? submitError}
            </p>
          )}

          <div className={styles.actions}>
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={frozen || submitting || !trimmed || Boolean(urlError)}
            >
              {hasSubmitted ? "Resubmit for review" : "Submit for review"}
            </Button>
            <SavedFlash state={saver.state} />
          </div>
          {saveError && (
            // SavedFlash says a change didn't land; this says WHICH refusal it
            // was, in the route's words. Both are true and neither replaces
            // the other.
            <p className={styles.error} role="status">
              {saveError.message}
              {conflict
                ? " Anything you have typed since then hasn't been saved — copy it out if you still need it."
                : ""}
            </p>
          )}
        </div>
      )}

      {stored?.reviewerComment && (
        <div className={styles.feedback}>
          <p className={styles.feedbackHead}>
            {stored.reviewerName ? (
              <>
                Feedback from <MemberName name={stored.reviewerName} />
              </>
            ) : (
              "Feedback from your facilitator"
            )}
          </p>
          {/* Staff prose, but a plain string — MemberText is the renderer. */}
          <MemberText text={stored.reviewerComment} className={styles.feedbackText} />
        </div>
      )}
    </div>
  );
}
