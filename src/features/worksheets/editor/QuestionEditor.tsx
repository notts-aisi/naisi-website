"use client";

import { useEffect, useRef, useState } from "react";
import BlockEditor from "@/components/blocks/BlockEditor";
import ImageUpload from "@/components/blocks/ImageUpload";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Switch from "@/components/ui/Switch";
import type { Block, BlockType } from "@/lib/firestore/newsletterBlocks";
import {
  WORKSHEET_LIMITS,
  WORKSHEET_QUESTION_TYPES,
  newItemId,
  questionHasOptions,
  questionHasText,
  type PollResultsVisibility,
  type WorksheetOption,
  type WorksheetQuestion,
  type WorksheetQuestionType,
} from "@/lib/firestore/worksheets";
import { changeQuestionType } from "./itemOps";
import styles from "./QuestionEditor.module.css";

type Props = {
  question: WorksheetQuestion;
  onChange: (next: WorksheetQuestion) => void;
  /**
   * The worksheet id or circulation id that owns the images this question
   * uploads. It is the `{ownerId}` segment of `worksheet-images/{ownerId}/…`,
   * which is the path `storage.rules` allows, so it has to be the real
   * document id rather than anything derived per question.
   */
  storageOwnerId: string;
  disabled?: boolean;
};

/**
 * The three block types a question or section body may hold. The list is
 * enforced twice on purpose: here, so the add menu never offers a heading or
 * a divider, and in `sanitizeItems`, so a body pasted in from a newsletter
 * draft still lands in the shape the respond page renders. See the comment on
 * `WORKSHEET_BODY_BLOCK_TYPES` in `src/lib/firestore/worksheets.ts`.
 */
const BODY_BLOCK_TYPES: BlockType[] = ["richText", "image", "video"];

/**
 * The poll audience, in the sender's words rather than the model's. "staff"
 * is what is stored; "Reviewers only" is what a person is choosing between.
 * The distinction that matters to them is whether the people answering can see
 * the running counts, and if so whether before or after their own answer is
 * locked in.
 */
const POLL_VISIBILITY_OPTIONS: { value: PollResultsVisibility; label: string }[] = [
  { value: "staff", label: "Reviewers only" },
  { value: "before-submit", label: "Everyone, straight away" },
  { value: "after-submit", label: "Everyone, after they submit" },
];

const LIMIT_UNIT_OPTIONS = [
  { value: "characters", label: "Characters" },
  { value: "words", label: "Words" },
];

function newOption(): WorksheetOption {
  return { id: newItemId("o"), label: "" };
}

/**
 * Read the number box. Blank and unparseable both become 0, which
 * `validateWorksheetItems` names as out of range under the row.
 *
 * The alternative, treating blank as "no limit", would switch the limit off
 * while the author was halfway through retyping the number, and take the
 * toggle above it with them.
 */
function parseCap(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

function rangeOptions(min: number, max: number): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let n = min; n <= max; n += 1) out.push({ value: String(n), label: String(n) });
  return out;
}

export default function QuestionEditor({ question, onChange, storageOwnerId, disabled }: Props) {
  // Which options have their image uploader open. Purely presentational: an
  // option that already carries an image shows the uploader regardless, and
  // nothing here is stored. Twenty uploaders open at once would bury the
  // labels, which are the part of an option that always matters.
  const [openImageIds, setOpenImageIds] = useState<Set<string>>(new Set());

  /**
   * The freshest `question` and `onChange`, for the one handler that fires
   * AFTER an await.
   *
   * `ImageUpload` compresses and then uploads before it calls back, which is
   * seconds during which the author carries on typing the option label sitting
   * beside the uploader. The handler's own closure holds the props from the
   * render in which the file was picked, so writing through it would land the
   * finished upload on top of a stale question and revert every keystroke
   * since. Reading the live pair out of this ref, and finding the option by ID
   * rather than by the index captured back then, is what lets the two edits
   * compose instead of one clobbering the other.
   *
   * Assigned in an effect rather than during render: the callback fires from a
   * user gesture long after commit, so it always sees the committed pair.
   */
  const latest = useRef({ question, onChange });
  useEffect(() => {
    latest.current = { question, onChange };
  });

  const options = question.options ?? [];
  const limit = question.limit;
  const ratingMax = question.rating?.max ?? WORKSHEET_LIMITS.defaultRatingMax;

  function patch(fields: Partial<WorksheetQuestion>) {
    onChange({ ...question, ...fields } as WorksheetQuestion);
  }

  /**
   * Turning the limit off DELETES the key rather than setting it to undefined.
   * An explicit `undefined` nested inside an array is refused outright by a
   * client-direct Firestore write, and `items` is written client-direct by the
   * editor's autosave, so `{ ...question, limit: undefined }` would be a save
   * that fails at the network rather than a question with no limit.
   */
  function setLimitEnabled(on: boolean) {
    if (on) {
      onChange({
        ...question,
        limit: { unit: "characters", max: WORKSHEET_LIMITS.defaultTextChars },
      });
      return;
    }
    const { limit: _dropped, ...rest } = question;
    onChange(rest);
  }

  function setType(type: WorksheetQuestionType) {
    onChange(changeQuestionType(question, type));
  }

  function setOptions(next: WorksheetOption[]) {
    patch({ options: next });
  }

  /** Rebuild `rating` from scratch so an emptied label loses its key. */
  function setRating(fields: { max?: number; minLabel?: string; maxLabel?: string }) {
    const rating: WorksheetQuestion["rating"] = {
      max: fields.max ?? question.rating?.max ?? WORKSHEET_LIMITS.defaultRatingMax,
    };
    const minLabel = fields.minLabel ?? question.rating?.minLabel;
    const maxLabel = fields.maxLabel ?? question.rating?.maxLabel;
    if (minLabel) rating.minLabel = minLabel;
    if (maxLabel) rating.maxLabel = maxLabel;
    patch({ rating });
  }

  function moveOption(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const next = options.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setOptions(next);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={`ws-type-${question.id}`}>
          Question type
        </label>
        <ResponsiveSelect
          id={`ws-type-${question.id}`}
          value={question.type}
          onChange={(next) => setType(next as WorksheetQuestionType)}
          options={WORKSHEET_QUESTION_TYPES.map((t) => ({ value: t.type, label: t.label }))}
          disabled={disabled}
          ariaLabel="Question type"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={`ws-title-${question.id}`}>
          Question
        </label>
        <input
          id={`ws-title-${question.id}`}
          type="text"
          className={styles.input}
          value={question.title}
          onChange={(e) => patch({ title: e.target.value })}
          maxLength={WORKSHEET_LIMITS.questionTitle}
          disabled={disabled}
          placeholder="e.g. What went well in your first term on committee?"
        />
        <span className={styles.counter}>
          {question.title.length} / {WORKSHEET_LIMITS.questionTitle}
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Anything they should read first (optional)</span>
        <BlockEditor
          draftId={storageOwnerId}
          storagePrefix="worksheet-images"
          blocks={question.body}
          onChange={(body: Block[]) => patch({ body })}
          disabled={disabled}
          allowedTypes={BODY_BLOCK_TYPES}
          compact
        />
      </div>

      <Switch
        checked={question.required}
        onChange={(next) => patch({ required: next })}
        disabled={disabled}
        label="Required"
        description="They cannot submit until this one is answered."
      />

      {questionHasText(question.type) && (
        <div className={styles.settings}>
          <Switch
            checked={Boolean(limit)}
            onChange={setLimitEnabled}
            disabled={disabled}
            label="Set an answer limit"
            description={
              limit
                ? undefined
                : `Without one, answers stop at ${WORKSHEET_LIMITS.defaultTextChars} characters.`
            }
          />

          {limit && (
            <>
              <div className={styles.inlineFields}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor={`ws-unit-${question.id}`}>
                    Counted in
                  </label>
                  <ResponsiveSelect
                    id={`ws-unit-${question.id}`}
                    value={limit.unit}
                    onChange={(next) =>
                      patch({ limit: { unit: next as "characters" | "words", max: limit.max } })
                    }
                    options={LIMIT_UNIT_OPTIONS}
                    disabled={disabled}
                    ariaLabel="Answer limit unit"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor={`ws-cap-${question.id}`}>
                    Most they can write
                  </label>
                  <input
                    id={`ws-cap-${question.id}`}
                    type="number"
                    className={styles.input}
                    value={limit.max === 0 ? "" : String(limit.max)}
                    min={1}
                    max={
                      limit.unit === "words"
                        ? WORKSHEET_LIMITS.maxTextWords
                        : WORKSHEET_LIMITS.maxTextChars
                    }
                    step={1}
                    onChange={(e) =>
                      patch({ limit: { unit: limit.unit, max: parseCap(e.target.value) } })
                    }
                    disabled={disabled}
                  />
                </div>
              </div>
              <p className={styles.preview}>
                They see this counter under the box:{" "}
                <span className={styles.previewCount}>
                  0 / {limit.max || 0}
                  {limit.unit === "words" ? " words" : ""}
                </span>
              </p>
            </>
          )}
        </div>
      )}

      {questionHasOptions(question.type) && (
        <div className={styles.settings}>
          <span className={styles.fieldLabel}>Options</span>
          <ul className={styles.optionList}>
            {options.map((option, i) => {
              const imageOpen = openImageIds.has(option.id) || Boolean(option.imageUrl);
              return (
                <li key={option.id} className={styles.option}>
                  <div className={styles.optionRow}>
                    <span className={styles.optionArrows}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => moveOption(i, -1)}
                        disabled={disabled || i === 0}
                        aria-label={`Move option ${i + 1} up`}
                        title="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => moveOption(i, 1)}
                        disabled={disabled || i === options.length - 1}
                        aria-label={`Move option ${i + 1} down`}
                        title="Move down"
                      >
                        ▼
                      </button>
                    </span>
                    <input
                      type="text"
                      className={styles.input}
                      value={option.label}
                      onChange={(e) => {
                        const next = options.slice();
                        next[i] = { ...option, label: e.target.value };
                        setOptions(next);
                      }}
                      maxLength={WORKSHEET_LIMITS.optionLabel}
                      disabled={disabled}
                      placeholder={`Option ${i + 1}`}
                      aria-label={`Option ${i + 1} label`}
                    />
                    <button
                      type="button"
                      className={styles.textBtn}
                      onClick={() =>
                        setOpenImageIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(option.id)) next.delete(option.id);
                          else next.add(option.id);
                          return next;
                        })
                      }
                      disabled={disabled || Boolean(option.imageUrl)}
                      title={
                        option.imageUrl
                          ? "Remove the picture below to close this"
                          : "Add a picture to this option"
                      }
                    >
                      {imageOpen ? "Picture" : "+ Picture"}
                    </button>
                    <button
                      type="button"
                      className={`${styles.textBtn} ${styles.dangerBtn}`}
                      onClick={() => setOptions(options.filter((o) => o.id !== option.id))}
                      disabled={disabled || options.length <= WORKSHEET_LIMITS.minOptions}
                      title={
                        options.length <= WORKSHEET_LIMITS.minOptions
                          ? `A question needs at least ${WORKSHEET_LIMITS.minOptions} options.`
                          : "Remove this option"
                      }
                    >
                      Remove
                    </button>
                  </div>

                  {imageOpen && (
                    <div className={styles.optionImage}>
                      <ImageUpload
                        draftId={storageOwnerId}
                        storagePrefix="worksheet-images"
                        currentUrl={option.imageUrl}
                        hideTextFields
                        onChange={(next) => {
                          // Through the ref, not the closure: this fires when
                          // the upload finishes, by which time `options` and
                          // `option` from this render may both be behind what
                          // the author has typed. See the comment on `latest`.
                          const live = latest.current.question;
                          const current = live.options ?? [];
                          const at = current.findIndex((o) => o.id === option.id);
                          // Removed while the upload was in flight. Re-adding
                          // it would resurrect a row deleted on purpose, so the
                          // finished image is simply dropped.
                          if (at < 0) return;
                          const target = current[at];
                          const updated = current.slice();
                          // Both halves or neither. `imageStoragePath` is what
                          // a later delete sweep needs, and a URL without one
                          // is a blob nothing can ever clean up. Clearing drops
                          // both KEYS rather than setting them to undefined,
                          // which a client-direct write inside an array
                          // refuses.
                          updated[at] =
                            next.url && next.storagePath
                              ? {
                                  ...target,
                                  imageUrl: next.url,
                                  imageStoragePath: next.storagePath,
                                }
                              : { id: target.id, label: target.label };
                          latest.current.onChange({
                            ...live,
                            options: updated,
                          } as WorksheetQuestion);
                        }}
                        disabled={disabled}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className={styles.addOptionBtn}
            onClick={() => setOptions([...options, newOption()])}
            disabled={disabled || options.length >= WORKSHEET_LIMITS.maxOptions}
            title={
              options.length >= WORKSHEET_LIMITS.maxOptions
                ? `A question can hold ${WORKSHEET_LIMITS.maxOptions} options.`
                : undefined
            }
          >
            + Add option
          </button>
        </div>
      )}

      {question.type === "poll" && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`ws-poll-${question.id}`}>
            Who sees the results
          </label>
          <ResponsiveSelect
            id={`ws-poll-${question.id}`}
            value={question.poll?.resultsVisibility ?? "staff"}
            onChange={(next) =>
              patch({ poll: { resultsVisibility: next as PollResultsVisibility } })
            }
            options={POLL_VISIBILITY_OPTIONS}
            disabled={disabled}
            ariaLabel="Who sees the poll results"
          />
        </div>
      )}

      {question.type === "rating" && (
        <div className={styles.settings}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`ws-rating-${question.id}`}>
              Scale runs 1 to
            </label>
            <ResponsiveSelect
              id={`ws-rating-${question.id}`}
              value={String(ratingMax)}
              onChange={(next) => setRating({ max: Number(next) })}
              options={rangeOptions(
                WORKSHEET_LIMITS.ratingScaleMin,
                WORKSHEET_LIMITS.ratingScaleMax,
              )}
              disabled={disabled}
              ariaLabel="Rating scale maximum"
            />
          </div>
          <div className={styles.inlineFields}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`ws-rating-min-${question.id}`}>
                Label for 1 (optional)
              </label>
              <input
                id={`ws-rating-min-${question.id}`}
                type="text"
                className={styles.input}
                value={question.rating?.minLabel ?? ""}
                onChange={(e) => setRating({ minLabel: e.target.value })}
                disabled={disabled}
                placeholder="e.g. Not at all"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`ws-rating-max-${question.id}`}>
                Label for {ratingMax} (optional)
              </label>
              <input
                id={`ws-rating-max-${question.id}`}
                type="text"
                className={styles.input}
                value={question.rating?.maxLabel ?? ""}
                onChange={(e) => setRating({ maxLabel: e.target.value })}
                disabled={disabled}
                placeholder="e.g. Completely"
              />
            </div>
          </div>
        </div>
      )}

      {question.type === "imageUpload" && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`ws-images-${question.id}`}>
            Pictures they may attach
          </label>
          <ResponsiveSelect
            id={`ws-images-${question.id}`}
            value={String(question.upload?.maxImages ?? WORKSHEET_LIMITS.minImagesPerAnswer)}
            onChange={(next) => patch({ upload: { maxImages: Number(next) } })}
            options={rangeOptions(
              WORKSHEET_LIMITS.minImagesPerAnswer,
              WORKSHEET_LIMITS.maxImagesPerAnswer,
            )}
            disabled={disabled}
            ariaLabel="Pictures allowed per answer"
          />
        </div>
      )}
    </div>
  );
}
