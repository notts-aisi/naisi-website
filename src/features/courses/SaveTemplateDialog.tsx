"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { TEMPLATE_LIMITS } from "@/lib/firestore/courseTemplates";
import styles from "./TemplatePicker.module.css";

/**
 * Name and confirm a curriculum snapshot.
 *
 * The dialog exists for one sentence, not for the text field: an admin pressing
 * "save as template" is about to freeze a copy of what a cohort was taught, and
 * the two properties that make that worth doing — ids are preserved, snapshots
 * are append-only — are invisible in the button. So the note is the content and
 * the label input is the form.
 *
 * The label is free text on purpose. It is a human version marker ("Autumn 2026
 * final", "pre-review draft"), not an identifier: the id is minted from course
 * title + label + a random suffix, so saving twice under one wording produces
 * two snapshots rather than overwriting the first.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  run: { label: string; courseTitle: string };
  /** Authored weeks on the run. Zero means there is nothing to freeze. */
  weekCount: number;
  /** A save in flight — the page's ActionToast owns the feedback. */
  saving: boolean;
  onSave: (label: string) => void;
};

export default function SaveTemplateDialog({
  open,
  onClose,
  run,
  weekCount,
  saving,
  onSave,
}: Props) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reseed on the open transition rather than in an effect (the RunEditor
  // `syncedRun` idiom, per the React docs): an effect would render the previous
  // dialog's half-typed label for a frame first. The Modal stays mounted so it
  // can animate closed, which is exactly why the reseed has to be explicit.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLabel(run.label ? `${run.label} final` : "");
      setError(null);
    }
  }

  const nothingToSave = weekCount === 0;

  function submit() {
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Give the snapshot a version label, e.g. “Autumn 2026 final”.");
      return;
    }
    setError(null);
    onSave(trimmed);
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Save this run as a template" width="md">
      <div className={styles.dialog}>
        <h2 className={styles.dialogTitle}>Save this run as a template</h2>

        <p className={styles.dialogBody}>
          Freezes the {weekCount} authored week{weekCount === 1 ? "" : "s"} of{" "}
          <strong>{run.label || "this run"}</strong> as a named iteration under{" "}
          {run.courseTitle || "this course"}.
        </p>

        <Field
          id="template-label"
          label="Version label"
          hint="How this iteration is told apart from the others, e.g. “Autumn 2026 final”."
        >
          <Input
            id="template-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={TEMPLATE_LIMITS.label}
            placeholder="Autumn 2026 final"
            disabled={saving || nothingToSave}
          />
        </Field>

        <p className={styles.dialogNote}>
          This snapshots the run&apos;s canonical curriculum as it stands now.
          Week, material, exercise and checklist ids are preserved, so progress
          recorded on a future re-run lines up with the item it belongs to.
          Templates are append-only: saving again adds another iteration and
          never overwrites this one. Where the cohort left ratings, the
          snapshot stores their headline figures alongside the weeks.
        </p>

        {nothingToSave && (
          <p className={styles.dialogError}>
            This run has no authored weeks yet, so there is nothing to snapshot.
          </p>
        )}
        {error && <p className={styles.dialogError}>{error}</p>}

        <div className={styles.dialogActions}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={saving || nothingToSave}>
            {saving ? "Saving…" : "Save template"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
