"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Switch from "@/components/ui/Switch";
import { youtubeIdFromUrl } from "@/lib/firestore/newsletterBlocks";
import {
  COURSE_FIELD_LIMITS,
  newMaterialId,
  validateSubmissionUrl,
  type Material,
  type MaterialType,
} from "@/lib/firestore/courses";
import { saveWeek } from "./courseMutations";
import styles from "./MaterialListEditor.module.css";

/**
 * The week's reading/watching list. One row per material, ordered — the order
 * here IS the order the cohort works through it, so reorder is a first-class
 * control rather than a sort field.
 *
 * Rows are edited as a FLAT draft shape (`MaterialRow`) rather than as the
 * `Material` union itself. Two reasons, both load-bearing:
 *
 *  1. Switching a row's kind keeps everything the author already typed. The
 *     union would force a lossy rebuild on every kind change (a mis-click
 *     costing a pasted URL is the kind of thing that stops people using a
 *     builder).
 *  2. Every value the inputs bind to is a `string` or `boolean`, so a cleared
 *     number field is `""` and never `undefined`. The `Material` written at
 *     save time is then assembled key-by-key, which is how "no `undefined`
 *     reaches Firestore" is guaranteed structurally rather than by discipline.
 *
 * Validation blocks the save on purpose. `sanitizeMaterials` DROPS rows that
 * fail `isValidMaterial` (a non-YouTube "video", most obviously), so an
 * unvalidated save would look like it worked and silently lose the row on the
 * next read.
 */

type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

type Props = {
  runId: string;
  weekId: string;
  /** The SAVED list. A change of identity (a reload) reseeds the draft. */
  materials: Material[];
  runAction: ToastRun;
  onSaved: () => void;
  disabled?: boolean;
};

/** The editable superset of every `Material` variant. See the module comment. */
type MaterialRow = {
  id: string;
  type: MaterialType;
  title: string;
  url: string;
  author: string;
  description: string;
  body: string;
  /** Raw input text — parsed (and validated) only at save time. */
  minutes: string;
  /** Inverse of the stored `optional` flag: authors think in "required". */
  required: boolean;
};

const KIND_OPTIONS: { value: MaterialType; label: string }[] = [
  { value: "reading", label: "Reading" },
  { value: "video", label: "Video" },
  { value: "link", label: "Link" },
  { value: "note", label: "Note" },
];

const KIND_HINT: Record<MaterialType, string> = {
  reading: "A paper, post or chapter. Opens in a new tab.",
  video: "Embedded from YouTube — anything else belongs under Link.",
  link: "Any other resource: a tool, a dataset, a slide deck.",
  note: "A short aside from you, shown inline in the list. Plain text.",
};

function toRow(m: Material): MaterialRow {
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    url: "url" in m ? m.url : "",
    author: m.type === "reading" ? (m.author ?? "") : "",
    description: m.type === "link" ? (m.description ?? "") : "",
    body: m.type === "note" ? m.body : "",
    minutes: m.estimatedMinutes != null ? String(m.estimatedMinutes) : "",
    required: !m.optional,
  };
}

function toRows(materials: Material[]): MaterialRow[] {
  return materials.map(toRow);
}

function emptyRow(): MaterialRow {
  return {
    id: newMaterialId(),
    type: "reading",
    title: "",
    url: "",
    author: "",
    description: "",
    body: "",
    minutes: "",
    required: true,
  };
}

/**
 * Assemble the stored `Material` from a row. Optional keys are OMITTED when
 * empty rather than written as `undefined` (Firestore rejects `undefined`) and
 * every string is trimmed + capped at the shared field budget.
 */
function buildMaterial(row: MaterialRow): Material {
  const minutes = Number(row.minutes.trim());
  const hasMinutes = row.minutes.trim() !== "" && Number.isFinite(minutes) && minutes > 0;
  const base = {
    id: row.id,
    title: row.title.trim().slice(0, COURSE_FIELD_LIMITS.materialTitle),
    optional: !row.required,
    ...(hasMinutes ? { estimatedMinutes: Math.round(minutes) } : {}),
  };
  const url = row.url.trim().slice(0, COURSE_FIELD_LIMITS.materialUrl);

  switch (row.type) {
    case "video":
      return { ...base, type: "video", url };
    case "reading": {
      const author = row.author.trim().slice(0, COURSE_FIELD_LIMITS.materialAuthor);
      return { ...base, type: "reading", url, ...(author ? { author } : {}) };
    }
    case "link": {
      const description = row.description
        .trim()
        .slice(0, COURSE_FIELD_LIMITS.materialDescription);
      return { ...base, type: "link", url, ...(description ? { description } : {}) };
    }
    case "note":
      return {
        ...base,
        type: "note",
        body: row.body.trim().slice(0, COURSE_FIELD_LIMITS.materialNoteBody),
      };
  }
}

/** Returns an error message for the row, or null when it is safe to store. */
function validateRow(row: MaterialRow): string | null {
  if (!row.title.trim()) return "Give this material a title.";

  const minutes = row.minutes.trim();
  if (minutes) {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return "Minutes must be a positive number, or blank.";
    }
  }

  switch (row.type) {
    case "video":
      // `isValidMaterial` requires a parseable YouTube id, so a Vimeo link
      // saved as a video would be dropped on the next read rather than
      // rendered. Caught here, with the fix named.
      if (youtubeIdFromUrl(row.url) === null) {
        return "Video needs a YouTube link (or a bare 11-character video id). For anything else, switch this row to Link.";
      }
      if (row.url.trim().length > COURSE_FIELD_LIMITS.materialUrl) {
        return "That link is too long.";
      }
      return null;
    case "reading":
    case "link":
      return validateSubmissionUrl(row.url, COURSE_FIELD_LIMITS.materialUrl);
    case "note":
      return row.body.trim() ? null : "A note needs some text, or remove the row.";
  }
}

export default function MaterialListEditor({
  runId,
  weekId,
  materials,
  runAction,
  onSaved,
  disabled,
}: Props) {
  const [rows, setRows] = useState<MaterialRow[]>(() => toRows(materials));
  const [syncedMaterials, setSyncedMaterials] = useState<Material[]>(materials);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Reseed whenever the saved list changes identity (first load, or a reload
  // after a save). Adjusted during render rather than in an effect, per the
  // React docs and WeekPlanBuilder's precedent — an effect would render the
  // stale rows for a frame first and trips the repo's set-state-in-effect lint.
  if (materials !== syncedMaterials) {
    setSyncedMaterials(materials);
    setRows(toRows(materials));
    setRowErrors({});
    setFormError(null);
  }

  const baseline = useMemo(() => JSON.stringify(toRows(materials)), [materials]);
  const dirty = JSON.stringify(rows) !== baseline;
  const full = rows.length >= COURSE_FIELD_LIMITS.maxMaterials;

  function patchRow(index: number, fields: Partial<MaterialRow>) {
    setRows((current) => {
      const next = current.slice();
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }

  function addRow() {
    if (full) return;
    setRows((current) => [...current, emptyRow()]);
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
      setFormError(
        `Fix the ${count} highlighted material${count === 1 ? "" : "s"} — a material that doesn't validate is dropped when the week is read back.`,
      );
      return;
    }
    setRowErrors({});
    setFormError(null);

    const built = rows.map(buildMaterial);
    let ok = false;
    await runAction(
      async () => {
        await saveWeek(runId, weekId, { materials: built });
        ok = true;
      },
      { savingMessage: "Saving materials…", successMessage: "Materials saved" },
    );
    // Only reload on success — reseeding after a failure would throw away the
    // edit the author still needs to retry.
    if (ok) onSaved();
  }

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        The order here is the order the cohort works through. Optional rows stay
        visible but don&apos;t count toward anyone&apos;s week progress.
      </p>

      {rows.length === 0 && (
        <p className={styles.empty}>
          No materials yet. Add the readings, videos and links this week is built
          around.
        </p>
      )}

      <ol className={styles.rows}>
        {rows.map((row, i) => {
          const error = rowErrors[row.id];
          return (
            <li key={row.id}>
              <Card padding="md" className={error ? styles.rowCardError : undefined}>
                <div className={styles.rowHeader}>
                  <span className={styles.rowIndex}>{i + 1}</span>
                  <div className={styles.kind}>
                    <ResponsiveSelect<MaterialType>
                      value={row.type}
                      onChange={(type) => patchRow(i, { type })}
                      options={KIND_OPTIONS}
                      ariaLabel={`Kind for material ${i + 1}`}
                      disabled={disabled}
                    />
                  </div>
                  <span className={styles.kindHint}>{KIND_HINT[row.type]}</span>
                  <div className={styles.controls}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, -1)}
                      disabled={disabled || i === 0}
                      aria-label={`Move material ${i + 1} earlier`}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, 1)}
                      disabled={disabled || i === rows.length - 1}
                      aria-label={`Move material ${i + 1} later`}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => removeRow(i)}
                      disabled={disabled}
                      aria-label={`Remove material ${i + 1}`}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className={styles.fields}>
                  <div className={styles.span}>
                    <Field id={`mat-title-${row.id}`} label="Title">
                      <Input
                        id={`mat-title-${row.id}`}
                        value={row.title}
                        onChange={(e) => patchRow(i, { title: e.target.value })}
                        maxLength={COURSE_FIELD_LIMITS.materialTitle}
                        placeholder="What the cohort sees in the list"
                        disabled={disabled}
                      />
                    </Field>
                  </div>

                  {row.type !== "note" && (
                    <div className={styles.span}>
                      <Field
                        id={`mat-url-${row.id}`}
                        label={row.type === "video" ? "YouTube link" : "Link"}
                        hint={
                          row.type === "video"
                            ? "A youtube.com or youtu.be URL, or the bare video id."
                            : "Opens in a new tab, with rel=noreferrer."
                        }
                      >
                        <Input
                          id={`mat-url-${row.id}`}
                          type="url"
                          inputMode="url"
                          value={row.url}
                          onChange={(e) => patchRow(i, { url: e.target.value })}
                          maxLength={COURSE_FIELD_LIMITS.materialUrl}
                          placeholder="https://"
                          disabled={disabled}
                        />
                      </Field>
                    </div>
                  )}

                  {row.type === "reading" && (
                    <div className={styles.span}>
                      <Field
                        id={`mat-author-${row.id}`}
                        label="Author or source"
                        hint="Optional attribution, e.g. “Ngo et al.”."
                      >
                        <Input
                          id={`mat-author-${row.id}`}
                          value={row.author}
                          onChange={(e) => patchRow(i, { author: e.target.value })}
                          maxLength={COURSE_FIELD_LIMITS.materialAuthor}
                          disabled={disabled}
                        />
                      </Field>
                    </div>
                  )}

                  {row.type === "link" && (
                    <div className={styles.span}>
                      <Field
                        id={`mat-desc-${row.id}`}
                        label="Why this link"
                        hint="Optional one-liner shown under the title."
                      >
                        <Input
                          id={`mat-desc-${row.id}`}
                          value={row.description}
                          onChange={(e) => patchRow(i, { description: e.target.value })}
                          maxLength={COURSE_FIELD_LIMITS.materialDescription}
                          disabled={disabled}
                        />
                      </Field>
                    </div>
                  )}

                  {row.type === "note" && (
                    <div className={styles.span}>
                      {/*
                        A plain textarea, not the block editor: `NoteMaterial.body`
                        is typed as plain text in the data model and renders inline
                        in the material list, so rich text would have nowhere to go.
                        Prose that wants formatting belongs in the week guide above.
                      */}
                      <Field id={`mat-body-${row.id}`} label="Note">
                        <CountedTextarea
                          id={`mat-body-${row.id}`}
                          value={row.body}
                          onChange={(e) => patchRow(i, { body: e.target.value })}
                          max={COURSE_FIELD_LIMITS.materialNoteBody}
                          rows={3}
                          placeholder="A short aside — context, a warning, what to look for."
                          disabled={disabled}
                        />
                      </Field>
                    </div>
                  )}

                  <Field
                    id={`mat-minutes-${row.id}`}
                    label="Minutes"
                    hint="Rough time cost. Blank if it varies."
                  >
                    <Input
                      id={`mat-minutes-${row.id}`}
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={row.minutes}
                      onChange={(e) => patchRow(i, { minutes: e.target.value })}
                      disabled={disabled}
                    />
                  </Field>

                  <div className={styles.switchCell}>
                    <Switch
                      checked={row.required}
                      onChange={(required) => patchRow(i, { required })}
                      label="Required"
                      description="Off = optional extension, excluded from progress."
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
          Add material
        </Button>
        <span className={styles.spacer} />
        <span className={styles.count}>
          {rows.length}/{COURSE_FIELD_LIMITS.maxMaterials} materials
          {full ? " — that's the cap" : ""}
        </span>
        <Button type="button" onClick={save} disabled={disabled || !dirty}>
          Save materials
        </Button>
      </div>
    </div>
  );
}
