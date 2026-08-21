"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
import {
  COURSE_FIELD_LIMITS,
  EXERCISE_MAX_LENGTH_DEFAULT,
  emptyExercise,
  type Exercise,
  type ExerciseResponseType,
} from "@/lib/firestore/courses";
import { EXERCISE_LIMITS } from "@/lib/firestore/courseExercises";
import { saveWeek } from "./courseMutations";
import styles from "./ExerciseBuilder.module.css";

/**
 * The week's exercises — the prompts members answer before their session.
 *
 * Shape copied from `FormBuilder` (add / per-item card / move / remove), types
 * deliberately NOT: an exercise is not a signup question. It carries a response
 * TYPE that the submit route asserts against the member's payload, a per-prompt
 * length cap, and a peer-visibility flag — none of which the events form
 * machinery models.
 *
 * Rows are edited as a flat draft (`maxLength` as raw input text) so a cleared
 * number field is `""` and never `undefined`; the stored `Exercise` is
 * assembled key-by-key at save time, which keeps `undefined` structurally out
 * of Firestore.
 */

type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

type Props = {
  runId: string;
  weekId: string;
  /** The SAVED list. A change of identity (a reload) reseeds the draft. */
  exercises: Exercise[];
  runAction: ToastRun;
  onSaved: () => void;
  disabled?: boolean;
};

type ExerciseRow = {
  id: string;
  prompt: string;
  helpText: string;
  responseType: ExerciseResponseType;
  required: boolean;
  /** Raw input text — parsed and clamped only at save time. */
  maxLength: string;
  peerVisible: boolean;
};

const RESPONSE_OPTIONS = [
  { value: "text", label: "Written answer" },
  { value: "link", label: "Link" },
] as const satisfies readonly { value: ExerciseResponseType; label: string }[];

function toRow(x: Exercise): ExerciseRow {
  return {
    id: x.id,
    prompt: x.prompt,
    helpText: x.helpText ?? "",
    responseType: x.responseType,
    required: x.required,
    maxLength: String(x.maxLength),
    peerVisible: x.peerVisible,
  };
}

function toRows(exercises: Exercise[]): ExerciseRow[] {
  return exercises.map(toRow);
}

function buildExercise(row: ExerciseRow): Exercise {
  const helpText = row.helpText.trim().slice(0, COURSE_FIELD_LIMITS.exerciseHelpText);
  const parsed = Number(row.maxLength.trim());
  const maxLength =
    row.maxLength.trim() && Number.isFinite(parsed)
      ? Math.min(EXERCISE_LIMITS.responseText, Math.max(1, Math.round(parsed)))
      : EXERCISE_MAX_LENGTH_DEFAULT;

  return {
    id: row.id,
    prompt: row.prompt.trim().slice(0, COURSE_FIELD_LIMITS.exercisePrompt),
    ...(helpText ? { helpText } : {}),
    responseType: row.responseType,
    required: row.required,
    maxLength,
    peerVisible: row.peerVisible,
  };
}

function validateRow(row: ExerciseRow): string | null {
  if (!row.prompt.trim()) return "Write the prompt, or remove this exercise.";
  if (row.responseType === "text" && row.maxLength.trim()) {
    const parsed = Number(row.maxLength.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return "The answer limit must be a positive number, or blank for the default.";
    }
  }
  return null;
}

export default function ExerciseBuilder({
  runId,
  weekId,
  exercises,
  runAction,
  onSaved,
  disabled,
}: Props) {
  const [rows, setRows] = useState<ExerciseRow[]>(() => toRows(exercises));
  const [syncedExercises, setSyncedExercises] = useState<Exercise[]>(exercises);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Reseed on a reload, adjusted during render rather than in an effect (React
  // docs; WeekPlanBuilder's precedent).
  if (exercises !== syncedExercises) {
    setSyncedExercises(exercises);
    setRows(toRows(exercises));
    setRowErrors({});
    setFormError(null);
  }

  const baseline = useMemo(() => JSON.stringify(toRows(exercises)), [exercises]);
  const dirty = JSON.stringify(rows) !== baseline;
  const full = rows.length >= COURSE_FIELD_LIMITS.maxExercises;

  function patchRow(index: number, fields: Partial<ExerciseRow>) {
    setRows((current) => {
      const next = current.slice();
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }

  function addRow() {
    if (full) return;
    setRows((current) => [...current, toRow(emptyExercise())]);
  }

  function removeRow(index: number) {
    setRows((current) => {
      const next = current.slice();
      next.splice(index, 1);
      return next;
    });
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    const errors: Record<string, string> = {};
    for (const row of rows) {
      const error = validateRow(row);
      if (error) errors[row.id] = error;
    }
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      const count = Object.keys(errors).length;
      setFormError(`Fix the ${count} highlighted exercise${count === 1 ? "" : "s"}.`);
      return;
    }
    setRowErrors({});
    setFormError(null);

    const built = rows.map(buildExercise);
    let ok = false;
    await runAction(
      async () => {
        await saveWeek(runId, weekId, { exercises: built });
        ok = true;
      },
      { savingMessage: "Saving exercises…", successMessage: "Exercises saved" },
    );
    if (ok) onSaved();
  }

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        Members answer these before the session. Responses are plain text or a
        link — never uploads — and the response type is re-checked server-side at
        submit, so changing it after people have answered can invalidate their
        work.
      </p>

      {rows.length === 0 && (
        <p className={styles.empty}>
          No exercises yet. Add the prompts this week asks the cohort to think
          through.
        </p>
      )}

      <ol className={styles.rows}>
        {rows.map((row, i) => {
          const error = rowErrors[row.id];
          return (
            <li key={row.id}>
              <Card padding="md" className={error ? styles.rowCardError : undefined}>
                <div className={styles.rowHeader}>
                  <span className={styles.rowTitle}>Exercise {i + 1}</span>
                  <div className={styles.controls}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, -1)}
                      disabled={disabled || i === 0}
                      aria-label={`Move exercise ${i + 1} earlier`}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, 1)}
                      disabled={disabled || i === rows.length - 1}
                      aria-label={`Move exercise ${i + 1} later`}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => removeRow(i)}
                      disabled={disabled}
                      aria-label={`Remove exercise ${i + 1}`}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className={styles.fields}>
                  <Field id={`ex-prompt-${row.id}`} label="Prompt">
                    <CountedTextarea
                      id={`ex-prompt-${row.id}`}
                      value={row.prompt}
                      onChange={(e) => patchRow(i, { prompt: e.target.value })}
                      max={COURSE_FIELD_LIMITS.exercisePrompt}
                      rows={3}
                      placeholder="The question the member answers."
                      disabled={disabled}
                    />
                  </Field>

                  <Field
                    id={`ex-help-${row.id}`}
                    label="Help text"
                    hint="Optional. Shown under the prompt — what a good answer looks like."
                  >
                    <CountedTextarea
                      id={`ex-help-${row.id}`}
                      value={row.helpText}
                      onChange={(e) => patchRow(i, { helpText: e.target.value })}
                      max={COURSE_FIELD_LIMITS.exerciseHelpText}
                      rows={2}
                      disabled={disabled}
                    />
                  </Field>

                  <div className={styles.settings}>
                    <Field
                      id={`ex-type-${row.id}`}
                      label="Response"
                      hint="Enforced at submit — a link answer can't be pasted into a written one."
                    >
                      <SegmentedControl<ExerciseResponseType>
                        value={row.responseType}
                        onChange={(responseType) => patchRow(i, { responseType })}
                        options={RESPONSE_OPTIONS}
                        ariaLabel={`Response type for exercise ${i + 1}`}
                        size="md"
                        disabled={disabled}
                      />
                    </Field>

                    {row.responseType === "text" && (
                      <Field
                        id={`ex-max-${row.id}`}
                        label="Answer limit"
                        hint={`Characters, up to ${EXERCISE_LIMITS.responseText}. Blank uses ${EXERCISE_MAX_LENGTH_DEFAULT}.`}
                      >
                        <Input
                          id={`ex-max-${row.id}`}
                          type="number"
                          min={1}
                          max={EXERCISE_LIMITS.responseText}
                          step={100}
                          inputMode="numeric"
                          value={row.maxLength}
                          onChange={(e) => patchRow(i, { maxLength: e.target.value })}
                          disabled={disabled}
                        />
                      </Field>
                    )}
                  </div>

                  <div className={styles.switches}>
                    <Switch
                      checked={row.required}
                      onChange={(required) => patchRow(i, { required })}
                      label="Required"
                      description="Members must answer this before the week counts as done."
                      disabled={disabled}
                    />
                    <Switch
                      checked={row.peerVisible}
                      onChange={(peerVisible) => patchRow(i, { peerVisible })}
                      label="Share with the group"
                      description="Visible to the member's group before the session."
                      disabled={disabled}
                    />
                  </div>
                </div>

                {error && <p className={styles.error}>{error}</p>}
              </Card>
            </li>
          );
        })}
      </ol>

      {formError && <p className={styles.error}>{formError}</p>}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={addRow}
          disabled={disabled || full}
        >
          Add exercise
        </Button>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {rows.length}/{COURSE_FIELD_LIMITS.maxExercises} exercises
          {full ? " — that's the cap" : ""}
        </span>
        <Button type="button" onClick={save} disabled={disabled || !dirty}>
          Save exercises
        </Button>
      </div>
    </div>
  );
}
