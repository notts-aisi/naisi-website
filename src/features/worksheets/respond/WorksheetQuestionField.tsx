"use client";

import CountedTextarea from "@/components/ui/CountedTextarea";
import { Input, Textarea } from "@/components/ui/Input";
import fr from "@/features/events/FormRenderer.module.css";
import {
  answerLimitOf,
  countWords,
  ratingScaleOf,
  type WorksheetAnswer,
  type WorksheetQuestion,
} from "@/lib/firestore/worksheets";
import ImageAnswer from "./ImageAnswer";
import styles from "./WorksheetQuestionField.module.css";

/**
 * One question's CONTROL, for the person answering it.
 *
 * The title, the required marker and the rich body are rendered by the page
 * above this: a question is a heading plus prose plus a control, and only the
 * control changes with the question's type. So this file is a switch on
 * `question.type` and nothing else.
 *
 * ── WHY NOT THE EVENTS FormRenderer ─────────────────────────────────────────
 * Recorded in docs/worksheets.md and worth repeating where somebody might try
 * it: FormRenderer keys choice answers by option LABEL, has no rich bodies, no
 * option images and no poll, rating or upload types, and it is the mobile
 * frozen RSVP baseline. Teaching it all of that would have put every one of
 * those on the RSVP flow. It shares its STYLESHEET with this file instead, so
 * the two look like one system without either owning the other's behaviour.
 *
 * ── THE CONTROLS COME FROM THE SHARED PRIMITIVES ────────────────────────────
 * `Input` and `CountedTextarea` rather than the events stylesheet's own
 * `.input`, because those carry the 44px minimum height and the 16px font that
 * stops iOS zooming the page on focus, and this is a member-facing surface
 * where the touch floor is enforced. The choice rows DO use the events
 * classes, which is where the shared look actually shows, composed with a
 * local `.optionRow` that puts the same 44px floor under a row the RSVP form
 * sizes for itself.
 *
 * ── EMPTY IS AN ANSWER SHAPE, NOT A MISSING ONE ─────────────────────────────
 * Clearing a box calls `onChange` with an empty answer of the right type
 * (`{ type: "text", text: "" }`), never with undefined. The autosave decides
 * from `answerIsEmpty` whether that means "store this" or "remove the key", in
 * one place, so no control has to know how a cleared answer is persisted.
 */

export type UploadAnswerImage = (
  file: File,
  questionId: string,
) => Promise<{ url: string; storagePath: string }>;

type Props = {
  question: WorksheetQuestion;
  answer: WorksheetAnswer | undefined;
  onChange: (next: WorksheetAnswer) => void;
  disabled?: boolean;
  /** One question's validation message, from `validateAnswer` or the route. */
  error?: string;
  /** Injected by the page, which knows the circulation the upload belongs to. */
  onUploadImage?: UploadAnswerImage;
  /**
   * Store the answer now rather than on the autosave's next beat. Called after
   * a change that cost the recipient something to make and would be expensive
   * to lose (an uploaded image), never on a keystroke.
   */
  onCommit?: () => void;
};

/**
 * Words rather than characters, for a question whose author set the limit that
 * way. `CountedTextarea` counts characters and enforces them with `maxLength`,
 * which is the right shape for a character cap and the wrong one here: a word
 * limit cannot be enforced by the browser (a word is not a keystroke), so this
 * counts and REPORTS, and `validateAnswer` refuses an over-long answer at
 * submit with the same number.
 */
function WordCountedTextarea({
  value,
  max,
  onChange,
  disabled,
  ariaLabel,
  ariaDescribedBy,
  ariaInvalid,
}: {
  value: string;
  max: number;
  onChange: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  ariaDescribedBy?: string;
  ariaInvalid?: true;
}) {
  const words = countWords(value);
  const near = words >= max * 0.9;
  return (
    <>
      <Textarea
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
      />
      <span
        className={near ? `${styles.counter} ${styles.counterNear}` : styles.counter}
        aria-live="polite"
      >
        {words} / {max} words
      </span>
    </>
  );
}

export default function WorksheetQuestionField({
  question,
  answer,
  onChange,
  disabled,
  error,
  onUploadImage,
  onCommit,
}: Props) {
  const errorId = `${question.id}-error`;
  const describedBy = error ? errorId : undefined;
  const invalid = error ? true : undefined;
  // The visible name is the heading the page renders above this control, so
  // the control carries the same words as its accessible name rather than a
  // second, different label.
  const label = question.title || "Your answer";

  const errorNote = error ? (
    <p id={errorId} className={fr.error} role="alert">
      {error}
    </p>
  ) : null;

  /**
   * The name of a group of radios or checkboxes, for a screen reader.
   *
   * A `<legend>` rather than `aria-label` on the `<fieldset>`: the visible
   * heading above this control is an `<h2>` on the page, which nothing
   * programmatically ties to the group, and a legend is the one association
   * HTML has for exactly this. Visually hidden because the heading is already
   * on screen and a second copy would read as a repeated title. And note what
   * is NOT here: `aria-invalid`, which a `group` role does not support (the
   * error is announced by the `role="alert"` line instead).
   */
  const groupName = <legend className="visually-hidden">{label}</legend>;

  switch (question.type) {
    case "shortText": {
      const limit = answerLimitOf(question);
      const text = answer?.type === "text" ? answer.text : "";
      return (
        <div className={fr.field}>
          <Input
            type="text"
            value={text}
            onChange={(e) => onChange({ type: "text", text: e.target.value })}
            disabled={disabled}
            // Only a CHARACTER cap can be enforced by the browser. A word cap
            // is counted beside the box and refused at submit.
            maxLength={limit.unit === "characters" ? limit.max : undefined}
            aria-label={label}
            aria-invalid={invalid}
            aria-describedby={describedBy}
          />
          {limit.unit === "words" && (
            <span
              className={
                countWords(text) >= limit.max * 0.9
                  ? `${styles.counter} ${styles.counterNear}`
                  : styles.counter
              }
              aria-live="polite"
            >
              {countWords(text)} / {limit.max} words
            </span>
          )}
          {errorNote}
        </div>
      );
    }

    case "longText": {
      const limit = answerLimitOf(question);
      const text = answer?.type === "text" ? answer.text : "";
      return (
        <div className={fr.field}>
          {limit.unit === "words" ? (
            <WordCountedTextarea
              value={text}
              max={limit.max}
              onChange={(next) => onChange({ type: "text", text: next })}
              disabled={disabled}
              ariaLabel={label}
              ariaDescribedBy={describedBy}
              ariaInvalid={invalid}
            />
          ) : (
            <CountedTextarea
              rows={5}
              value={text}
              max={limit.max}
              onChange={(e) => onChange({ type: "text", text: e.target.value })}
              disabled={disabled}
              aria-label={label}
              aria-invalid={invalid}
              aria-describedby={describedBy}
            />
          )}
          {errorNote}
        </div>
      );
    }

    case "singleChoice":
    case "poll": {
      const options = question.options ?? [];
      const chosen = answer?.type === "choice" ? answer.optionId : "";
      const visibility = question.poll?.resultsVisibility;
      // `disabled` is this control's read-only signal, and on this page it
      // means the response is frozen: the recipient has submitted. So an
      // "after-submit" poll shows its results panel here and its promise
      // everywhere else. "staff" says nothing to the recipient at all.
      const pollNote =
        question.type !== "poll"
          ? null
          : visibility === "before-submit"
            ? "Results are shown after you answer."
            : visibility === "after-submit" && !disabled
              ? "Results are shown once you have submitted."
              : null;
      const showPollResults =
        question.type === "poll" &&
        (visibility === "before-submit" ||
          (visibility === "after-submit" && Boolean(disabled)));
      return (
        <fieldset className={`${fr.field} ${fr.choiceField}`} aria-describedby={describedBy}>
          {groupName}
          <div className={fr.checkGrid}>
            {options.map((option) => (
              <label
                key={option.id}
                className={
                  option.imageUrl
                    ? `${fr.checkRow} ${styles.optionRow} ${styles.optionWithImage}`
                    : `${fr.checkRow} ${styles.optionRow}`
                }
              >
                {option.imageUrl && (
                  // The label beside it names the option, so the picture adds
                  // nothing for a screen reader and is marked decorative.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={option.imageUrl} alt="" className={styles.optionImage} />
                )}
                <span className={styles.optionLabelRow}>
                  <input
                    type="radio"
                    name={question.id}
                    checked={chosen === option.id}
                    disabled={disabled}
                    onChange={() => onChange({ type: "choice", optionId: option.id })}
                  />
                  <span>{option.label}</span>
                </span>
              </label>
            ))}
          </div>
          {pollNote && <p className={styles.pollNote}>{pollNote}</p>}
          {/* The aggregate route is wave 2. Saying so beats a bar chart of
              zeroes, which reads as "nobody agrees with you". */}
          {showPollResults && (
            <p className={styles.pollResults}>Results: coming in the next wave.</p>
          )}
          {errorNote}
        </fieldset>
      );
    }

    case "multipleChoice": {
      const options = question.options ?? [];
      const chosen = answer?.type === "choices" ? answer.optionIds : [];
      return (
        <fieldset className={`${fr.field} ${fr.choiceField}`} aria-describedby={describedBy}>
          {groupName}
          <div className={fr.checkGrid}>
            {options.map((option) => {
              const checked = chosen.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={
                    option.imageUrl
                      ? `${fr.checkRow} ${styles.optionRow} ${styles.optionWithImage}`
                      : `${fr.checkRow} ${styles.optionRow}`
                  }
                >
                  {option.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={option.imageUrl} alt="" className={styles.optionImage} />
                  )}
                  <span className={styles.optionLabelRow}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange({
                          type: "choices",
                          // Rebuilt in the AUTHOR'S order rather than in tick
                          // order, so two people who picked the same options
                          // export as the same string.
                          optionIds: options
                            .filter((o) =>
                              o.id === option.id ? e.target.checked : chosen.includes(o.id),
                            )
                            .map((o) => o.id),
                        })
                      }
                    />
                    <span>{option.label}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {errorNote}
        </fieldset>
      );
    }

    case "rating": {
      const max = ratingScaleOf(question);
      const value = answer?.type === "rating" ? answer.value : 0;
      const minLabel = question.rating?.minLabel ?? "";
      const maxLabel = question.rating?.maxLabel ?? "";
      return (
        <div
          className={fr.field}
          role="group"
          aria-label={label}
          aria-describedby={describedBy}
        >
          <div className={styles.ratingRow}>
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={
                  n === value
                    ? `${styles.ratingButton} ${styles.ratingButtonOn}`
                    : styles.ratingButton
                }
                aria-pressed={n === value}
                disabled={disabled}
                // Pressing the chosen number again clears it. A rating is the
                // one control here with no empty state of its own, and an
                // optional question somebody answered by accident would
                // otherwise be unanswerable back to blank.
                onClick={() => onChange({ type: "rating", value: n === value ? 0 : n })}
              >
                {n}
              </button>
            ))}
          </div>
          {(minLabel || maxLabel) && (
            <div className={styles.ratingEnds}>
              <span>{minLabel}</span>
              <span>{maxLabel}</span>
            </div>
          )}
          {errorNote}
        </div>
      );
    }

    case "imageUpload": {
      return (
        <div className={fr.field}>
          <ImageAnswer
            question={question}
            answer={answer}
            onChange={onChange}
            disabled={disabled}
            onUpload={
              onUploadImage ? (file: File) => onUploadImage(file, question.id) : undefined
            }
            onCommit={onCommit}
          />
          {errorNote}
        </div>
      );
    }
  }
}
