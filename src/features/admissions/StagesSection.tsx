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
  nextAdmissionStageId,
  type AdmissionRoundDoc,
} from "@/lib/firestore/admissionRounds";
import {
  deleteStage,
  releaseStage,
  saveStage,
  type Stage,
  type StageReleaseResult,
} from "./roundClient";
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
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function addStage() {
    // One past the highest id this round has used, matching the server. The
    // list's LENGTH would name a stage that is still there as soon as one has
    // been deleted, and the save behind it would blank that stage's questions.
    const stageId = nextAdmissionStageId(round.stageIds);
    setAdding(true);
    setAddError(null);
    try {
      const saved = await saveStage(
        round.id,
        stageId,
        {
          label: `Stage ${round.stageIds.length + 1}`,
          intro: "",
          questions: [],
          releaseAt: null,
          releaseTimeLocal: "09:00",
          closesAt: null,
          locksOnSubmit: false,
        },
        { create: true },
      );
      onStagesChange([...stages, saved]);
      onRoundChange([...round.stageIds, stageId]);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "That stage was not added.");
    } finally {
      setAdding(false);
    }
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
        <Button
          type="button"
          variant="secondary"
          onClick={addStage}
          disabled={!canAddStage || adding}
        >
          {adding ? "Adding…" : "Add a stage"}
        </Button>
        {!canAddStage && (
          <span className={styles.hint}>
            A round takes at most {ADMISSION_ROUND_FIELD_LIMITS.maxStages} stages.
          </span>
        )}
      </div>
      {addError && <p className={styles.error}>{addError}</p>}
    </div>
  );
}

/**
 * One plain sentence about what pressing Release just did.
 *
 * The release and the announcement are two different things and this line
 * always says so, because "released" on its own leaves an admin guessing
 * whether anybody was told.
 *
 * ONE SENTENCE PER REASON, and the reason comes off the notice rather than
 * being inferred here. An earlier version inferred it, and said "this stage
 * had already been announced" to every case the job declined, a round whose
 * window is not open included: an admin reading that goes looking for an
 * announcement nobody made.
 *
 * FAILURES ARE READ FIRST. A transport outage during a hand release leaves an
 * empty audience behind it, and reporting that as "nobody has a live
 * application" would be the one wrong answer with a remedy attached.
 */
function releaseNoteFor(result: StageReleaseResult): string {
  if (result.alreadyReleased) {
    return "This stage was already released, so nothing changed and nobody was emailed again.";
  }
  const notice = result.notice;
  if (!notice) return "Released.";
  if (!notice.attempted) return notice.note ?? "Released. Nobody was emailed.";

  if (notice.failed > 0 && notice.sent === 0) {
    const n = notice.failed;
    return (
      `Released. Nothing was emailed: ${n} send${n === 1 ? "" : "s"} failed. ` +
      "The questions are on everybody's form regardless; docs/courses-ops.md " +
      "says what to do about the people who were not told."
    );
  }

  switch (notice.reason) {
    case "too-late":
      return "Released. No announcement went out: this stage opened too long ago for an email about it to be worth sending. Tell people by hand if it still matters.";
    case "already-announced":
      return "Released. No announcement went out: everybody live on this round has already had it.";
    case "round-not-in-window":
      return "Released. Nobody was emailed: this round is not taking applications right now, so there was nobody to tell.";
    case "stage-not-released":
      return "Released. Nobody was emailed: the announcement job does not read this stage as newly opened, so it has nothing to announce.";
    case "no-live-applications":
      return "Released. Nobody has a live application on this round, so no email went out.";
    case "scheduler-off":
    case "job-off":
    case "failed":
      return notice.note ?? "Released. Nobody was emailed.";
    case "announced":
      break;
  }

  const parts = [
    `Released, and emailed ${notice.sent} applicant${notice.sent === 1 ? "" : "s"}`,
  ];
  if (notice.skipped > 0) parts.push(`${notice.skipped} skipped`);
  if (notice.failed > 0) parts.push(`${notice.failed} did not send`);
  const tail = notice.hasMore ? " The rest go out on the next scheduler run." : "";
  return `${parts.join(", ")}.${tail}`;
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
  /**
   * What the release did about telling people. Kept separate from `error`:
   * the release itself succeeded in every case that puts a line here, and
   * conflating the two would have the console reporting a released stage as
   * a failure because the scheduler is dark.
   */
  const [releaseNote, setReleaseNote] = useState<string | null>(null);

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
    setReleaseNote(null);
    try {
      const result = await releaseStage(round.id, stage.id);
      onSaved(result.stage);
      setReleaseNote(releaseNoteFor(result));
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
      {releaseNote && <p className={styles.hint}>{releaseNote}</p>}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
