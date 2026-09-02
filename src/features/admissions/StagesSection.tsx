"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import Switch from "@/components/ui/Switch";
import FormBuilder from "@/features/events/FormBuilder";
import type { FormQuestion } from "@/lib/firestore/events";
import {
  ADMISSION_ROUND_FIELD_LIMITS,
  admissionStageId,
  type AdmissionRoundDoc,
} from "@/lib/firestore/admissionRounds";
import { deleteStage, releaseStage, saveStage, type Stage } from "./roundClient";
import styles from "./RoundEditor.module.css";

/**
 * The stages: each one a block of questions with its own release date.
 *
 * ## Why the questions are edited here and nowhere else
 *
 * `admissionRounds/{roundId}/stages/{stageId}` is `allow read, write: if
 * false`, which is the timed-release guarantee itself: the only way a question
 * reaches a browser is a route that checked `isStageReleased` first. So this
 * editor talks to the stage route rather than writing client-direct like the
 * course editors do, and the questions it renders arrived on a payload that
 * only an author is served.
 *
 * ## The character limit is checked by the SERVER, and named
 *
 * `FormBuilder` offers a per-question character limit. A number out of range
 * is refused by the stage route with the question named, because the sanitiser
 * behind the save is `raw.filter(isValidQuestion)`: a range check inside that
 * predicate would delete the question instead of complaining about it. The
 * refusal is surfaced verbatim here.
 */
export default function StagesSection({
  round,
  stages,
  onStagesChange,
  onRoundChange,
}: {
  round: AdmissionRoundDoc;
  stages: Stage[];
  onStagesChange: (next: Stage[]) => void;
  onRoundChange: (stageIds: string[]) => void;
}) {
  const canAddStage = round.stageIds.length < ADMISSION_ROUND_FIELD_LIMITS.maxStages;

  async function addStage() {
    const stageId = admissionStageId(round.stageIds.length);
    const saved = await saveStage(round.id, stageId, {
      label: `Stage ${round.stageIds.length + 1}`,
      intro: "",
      questions: [],
      releaseAt: null,
      releaseTimeLocal: "09:00",
      closesAt: null,
      locksOnSubmit: false,
    });
    onStagesChange([...stages, saved]);
    onRoundChange([...round.stageIds, stageId]);
  }

  return (
    <div className={styles.body}>
      {stages.map((stage) => (
        <StageEditor
          key={stage.id}
          round={round}
          stage={stage}
          canDelete={stages.length > 1}
          onSaved={(next) =>
            onStagesChange(stages.map((s) => (s.id === next.id ? next : s)))
          }
          onDeleted={() => {
            const remaining = stages.filter((s) => s.id !== stage.id);
            onStagesChange(remaining.map((s, index) => ({ ...s, order: index })));
            onRoundChange(round.stageIds.filter((id) => id !== stage.id));
          }}
        />
      ))}

      <div className={styles.actions}>
        <Button type="button" variant="secondary" onClick={addStage} disabled={!canAddStage}>
          Add a stage
        </Button>
        {!canAddStage && (
          <span className={styles.hint}>
            A round takes at most {ADMISSION_ROUND_FIELD_LIMITS.maxStages} stages.
          </span>
        )}
      </div>
    </div>
  );
}

function StageEditor({
  round,
  stage,
  canDelete,
  onSaved,
  onDeleted,
}: {
  round: AdmissionRoundDoc;
  stage: Stage;
  canDelete: boolean;
  onSaved: (stage: Stage) => void;
  onDeleted: () => void;
}) {
  const L = ADMISSION_ROUND_FIELD_LIMITS;
  const [label, setLabel] = useState(stage.label);
  const [intro, setIntro] = useState(stage.intro);
  const [questions, setQuestions] = useState<FormQuestion[]>(stage.questions);
  const [releaseAt, setReleaseAt] = useState(stage.releaseAt ?? "");
  const [releaseTimeLocal, setReleaseTimeLocal] = useState(stage.releaseTimeLocal);
  const [locksOnSubmit, setLocksOnSubmit] = useState(stage.locksOnSubmit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await saveStage(round.id, stage.id, {
        label,
        intro,
        questions,
        releaseAt: releaseAt || null,
        releaseTimeLocal,
        // A per-stage deadline is deliberately not offered yet: with one stage
        // it is the round's own, and the route already refuses one later than
        // the round's. It stays on the document for the weekly-questions shape.
        closesAt: stage.closesAt ? stage.closesAt.toISOString() : null,
        locksOnSubmit,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await releaseStage(round.id, stage.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not release.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteStage(round.id, stage.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not delete.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.stage}>
      <div className={styles.stageHead}>
        <h3 className={styles.stageTitle}>
          Stage {stage.order + 1}
          {stage.manualReleasedAt ? " · released by hand" : ""}
        </h3>
        <div className={styles.statusRow}>
          <Button type="button" variant="secondary" onClick={release} disabled={busy}>
            {stage.manualReleasedAt ? "Released" : "Release now"}
          </Button>
          {canDelete && (
            <Button type="button" variant="ghost" onClick={remove} disabled={busy}>
              Delete stage
            </Button>
          )}
        </div>
      </div>

      <div className={styles.grid2}>
        <Field id={`stage-${stage.id}-label`} label="Name">
          <Input
            id={`stage-${stage.id}-label`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={L.stageLabel}
          />
        </Field>
        <Field
          id={`stage-${stage.id}-release`}
          label="Release date"
          hint="Leave empty to release with the round"
        >
          <Input
            id={`stage-${stage.id}-release`}
            type="date"
            value={releaseAt}
            onChange={(e) => setReleaseAt(e.target.value)}
          />
        </Field>
      </div>

      <div className={styles.grid2}>
        <Field
          id={`stage-${stage.id}-time`}
          label="Release time"
          hint="London time on the release date"
        >
          <Input
            id={`stage-${stage.id}-time`}
            type="time"
            value={releaseTimeLocal}
            onChange={(e) => setReleaseTimeLocal(e.target.value)}
          />
        </Field>
        <Switch
          checked={locksOnSubmit}
          onChange={setLocksOnSubmit}
          label="Lock these answers on submit"
          description="Freeze this stage once it is submitted, even while the round stays open."
        />
      </div>

      <Field id={`stage-${stage.id}-intro`} label="Introduction">
        <CountedTextarea
          id={`stage-${stage.id}-intro`}
          value={intro}
          max={L.stageIntro}
          rows={3}
          onChange={(e) => setIntro(e.target.value)}
        />
      </Field>

      <FormBuilder
        questions={questions}
        onChange={setQuestions}
        showPresets={false}
        hiddenTypes={["dietaryAllergies"]}
        emptyStateHint="No questions on this stage yet. Applicants would reach an empty form."
      />

      <div className={styles.actions}>
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save stage"}
        </Button>
        {saved && !error && <span className={styles.saved}>Saved.</span>}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
