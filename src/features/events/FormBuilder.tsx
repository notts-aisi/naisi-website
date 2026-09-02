"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import {
  DEFAULT_ANSWER_MAX_LENGTH,
  emptyQuestion,
  QUESTION_HELP_TEXT_MAX,
  QUESTION_MAX_LENGTH_MAX,
  QUESTION_MAX_LENGTH_MIN,
  type FormQuestion,
  type FormQuestionType,
} from "@/lib/firestore/events";
import { FORM_PRESETS } from "./formPresets";
import styles from "./FormBuilder.module.css";

type Props = {
  questions: FormQuestion[];
  onChange: (next: FormQuestion[]) => void;
  disabled?: boolean;
  /**
   * Hide the events preset picker and the food/dietary question type.
   * Course application forms reuse this builder, where burger presets and
   * an allergies checklist make no sense.
   */
  showPresets?: boolean;
  hiddenTypes?: FormQuestionType[];
  /** Replaces the events-flavoured empty-state copy. */
  emptyStateHint?: string;
};

const TYPE_LABEL: Record<FormQuestionType, string> = {
  shortText: "Short text",
  longText: "Long text",
  singleSelect: "Single choice",
  multiSelect: "Multiple choice",
  yesNo: "Yes / No",
  dietaryAllergies: "Allergies checklist",
};

/**
 * Whether this question can receive free text at all, and so whether a
 * character limit means anything for it. Short and long text are the answer
 * itself; the other two are "Other" boxes, which `validateAnswers` caps with
 * the same number.
 */
function acceptsFreeText(q: FormQuestion): boolean {
  return (
    q.type === "shortText" ||
    q.type === "longText" ||
    q.type === "dietaryAllergies" ||
    (q.type === "multiSelect" && Boolean(q.allowOther))
  );
}

/**
 * Read a typed character limit. Blank clears it back to the default, and
 * anything unparseable is treated as blank rather than as zero. The range is
 * NOT clamped here: the saving route refuses an out-of-range number and names
 * the question, and the hint below the input says so before they get there.
 */
function parseLimit(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

const ADD_MENU: Array<{ type: FormQuestionType; hint: string }> = [
  { type: "shortText", hint: "One-line answer" },
  { type: "longText", hint: "Multi-line text" },
  { type: "singleSelect", hint: "Pick one option" },
  { type: "multiSelect", hint: "Pick any number" },
  { type: "yesNo", hint: "Yes / No toggle" },
  { type: "dietaryAllergies", hint: "Checkbox list of common allergies" },
];

export default function FormBuilder({
  questions,
  onChange,
  disabled,
  showPresets = true,
  hiddenTypes = [],
  emptyStateHint,
}: Props) {
  const addMenu = ADD_MENU.filter((item) => !hiddenTypes.includes(item.type));
  const [adding, setAdding] = useState(false);
  const [presetWarning, setPresetWarning] = useState<string | null>(null);

  function patch(index: number, fields: Partial<FormQuestion>) {
    const next = questions.slice();
    next[index] = { ...next[index], ...fields } as FormQuestion;
    onChange(next);
  }

  function addQuestion(type: FormQuestionType) {
    onChange([...questions, emptyQuestion(type)]);
    setAdding(false);
  }

  function removeQuestion(index: number) {
    const next = questions.slice();
    next.splice(index, 1);
    onChange(next);
  }

  function moveQuestion(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= questions.length) return;
    const next = questions.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function applyPreset(presetId: string) {
    if (!presetId) return;
    const preset = FORM_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    if (questions.length > 0) {
      if (!window.confirm(`Replace the current form with the "${preset.label}" preset? Your existing questions will be lost.`)) {
        return;
      }
    }
    onChange(preset.build());
    setPresetWarning(null);
  }

  return (
    <div className={styles.wrap}>
      {showPresets && (
      <Card padding="md">
        <div className={styles.presetRow}>
          <label className={styles.presetLabel} htmlFor="form-preset">
            <strong>Start from a preset</strong>
            <span>Pick a template, then tweak the questions. You can always add or remove.</span>
          </label>
          <ResponsiveSelect
            value=""
            onChange={(next) => {
              if (next) applyPreset(next);
            }}
            options={[
              { value: "", label: "Choose a preset…", disabled: true },
              ...FORM_PRESETS.map((p) => ({
                value: p.id,
                label: `${p.label} — ${p.description}`,
              })),
            ]}
            disabled={disabled}
            ariaLabel="Form preset"
          />
        </div>
        {presetWarning && <p className={styles.warn}>{presetWarning}</p>}
      </Card>
      )}

      {questions.length === 0 && (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            {emptyStateHint ??
              "No signup questions yet. Pick a preset above or add a question below. Attendees will always be asked their name and email — you only need questions for the extras."}
          </p>
        </Card>
      )}

      {questions.map((q, i) => (
        <Card key={q.id} padding="md">
          <div className={styles.qHeader}>
            <span className={styles.qType}>{TYPE_LABEL[q.type]}</span>
            <div className={styles.qControls}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => moveQuestion(i, -1)}
                disabled={disabled || i === 0}
                aria-label="Move up"
                title="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => moveQuestion(i, 1)}
                disabled={disabled || i === questions.length - 1}
                aria-label="Move down"
                title="Move down"
              >
                ▼
              </button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={() => removeQuestion(i)}
                disabled={disabled}
              >
                Delete
              </button>
            </div>
          </div>

          <div className={styles.qBody}>
            <label className={styles.fieldLabel}>
              <span>Question</span>
              <input
                type="text"
                className={styles.fieldInput}
                value={q.label}
                onChange={(e) => patch(i, { label: e.target.value } as Partial<FormQuestion>)}
                disabled={disabled}
                placeholder="e.g. Any food allergies?"
              />
            </label>

            {(q.type === "shortText" || q.type === "longText") && (
              <label className={styles.fieldLabel}>
                <span>Placeholder (optional)</span>
                <input
                  type="text"
                  className={styles.fieldInput}
                  value={q.placeholder ?? ""}
                  onChange={(e) =>
                    patch(i, { placeholder: e.target.value } as Partial<FormQuestion>)
                  }
                  disabled={disabled}
                  placeholder="e.g. e.g. vegan, halal, nut allergy"
                />
              </label>
            )}

            {(q.type === "singleSelect" || q.type === "multiSelect") && (
              <OptionsEditor
                options={q.options}
                onChange={(options) =>
                  patch(i, { options } as Partial<FormQuestion>)
                }
                disabled={disabled}
              />
            )}

            {q.type === "multiSelect" && (
              <>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={Boolean(q.allowOther)}
                    onChange={(e) =>
                      patch(i, { allowOther: e.target.checked } as Partial<FormQuestion>)
                    }
                    disabled={disabled}
                  />
                  Include an &quot;Other&quot; box people can type into
                </label>
                <label className={styles.fieldLabel}>
                  <span>&quot;None of these&quot; option (optional)</span>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    value={q.noneOption ?? ""}
                    onChange={(e) =>
                      patch(i, {
                        noneOption: e.target.value || undefined,
                      } as Partial<FormQuestion>)
                    }
                    disabled={disabled}
                    placeholder="e.g. No, I'm happy with any toppings"
                  />
                </label>
              </>
            )}

            {q.type === "dietaryAllergies" && (
              <p className={styles.helper}>
                Attendees see a checklist of common allergies and dietary
                requirements (vegetarian, vegan, and the major allergens), a
                &quot;no requirements&quot; option, and a free-text box for
                anything else.
              </p>
            )}

            <label className={styles.fieldLabel}>
              <span>Help text (optional)</span>
              <input
                type="text"
                className={styles.fieldInput}
                value={q.helpText ?? ""}
                onChange={(e) =>
                  patch(i, {
                    helpText: e.target.value || undefined,
                  } as Partial<FormQuestion>)
                }
                disabled={disabled}
                maxLength={QUESTION_HELP_TEXT_MAX}
                placeholder="e.g. Two or three sentences is plenty"
              />
              <span className={styles.helper}>
                Shown under the question, before the answer box.
              </span>
            </label>

            {acceptsFreeText(q) && (
              <label className={styles.fieldLabel}>
                <span>Character limit (optional)</span>
                <input
                  type="number"
                  className={styles.fieldInput}
                  value={q.maxLength ?? ""}
                  min={QUESTION_MAX_LENGTH_MIN}
                  max={QUESTION_MAX_LENGTH_MAX}
                  step={1}
                  onChange={(e) =>
                    patch(i, {
                      maxLength: parseLimit(e.target.value),
                    } as Partial<FormQuestion>)
                  }
                  disabled={disabled}
                  placeholder={String(DEFAULT_ANSWER_MAX_LENGTH)}
                />
                {q.maxLength === undefined ? (
                  <span className={styles.helper}>
                    Blank means the default of {DEFAULT_ANSWER_MAX_LENGTH}{" "}
                    characters.
                  </span>
                ) : q.maxLength < QUESTION_MAX_LENGTH_MIN ||
                  q.maxLength > QUESTION_MAX_LENGTH_MAX ? (
                  <span className={styles.warn}>
                    Must be between {QUESTION_MAX_LENGTH_MIN} and{" "}
                    {QUESTION_MAX_LENGTH_MAX}. Saving will be refused until you
                    fix it.
                  </span>
                ) : (
                  <span className={styles.helper}>
                    Answers stop at {q.maxLength} characters, with a live
                    counter on long text.
                  </span>
                )}
              </label>
            )}

            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={q.required}
                onChange={(e) =>
                  patch(i, { required: e.target.checked } as Partial<FormQuestion>)
                }
                disabled={disabled}
              />
              Required
            </label>
          </div>
        </Card>
      ))}

      {adding ? (
        <Card padding="md">
          <div className={styles.addMenuHeader}>
            <strong>Add a question</strong>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className={styles.ghostBtn}
            >
              Cancel
            </button>
          </div>
          <div className={styles.addMenuGrid}>
            {addMenu.map((item) => (
              <button
                key={item.type}
                type="button"
                className={styles.addMenuItem}
                onClick={() => addQuestion(item.type)}
              >
                <strong>{TYPE_LABEL[item.type]}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </div>
        </Card>
      ) : (
        <button
          type="button"
          className={styles.addBigBtn}
          onClick={() => setAdding(true)}
          disabled={disabled}
        >
          + Add question
        </button>
      )}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
  disabled,
}: {
  options: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  function patch(i: number, v: string) {
    const next = options.slice();
    next[i] = v;
    onChange(next);
  }
  function add() {
    onChange([...options, ""]);
  }
  function remove(i: number) {
    const next = options.slice();
    next.splice(i, 1);
    onChange(next.length === 0 ? [""] : next);
  }
  return (
    <div className={styles.optionsWrap}>
      <span className={styles.fieldLabel}>
        <span>Options</span>
      </span>
      {options.map((opt, i) => (
        <div key={i} className={styles.optionRow}>
          <input
            type="text"
            className={styles.fieldInput}
            value={opt}
            onChange={(e) => patch(i, e.target.value)}
            disabled={disabled}
            placeholder={`Option ${i + 1}`}
          />
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => remove(i)}
            disabled={disabled || options.length <= 1}
            aria-label={`Remove option ${i + 1}`}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.ghostBtn}
        onClick={add}
        disabled={disabled}
      >
        + Add option
      </button>
    </div>
  );
}
