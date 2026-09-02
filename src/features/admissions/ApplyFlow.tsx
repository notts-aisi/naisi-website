"use client";

import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Input } from "@/components/ui/Input";
import MemberText from "@/components/ui/MemberText";
import {
  RECAPTCHA_ENABLED,
  RecaptchaInvisible,
  type RecaptchaHandle,
} from "@/components/ui/RecaptchaInvisible";
import FormRenderer from "@/features/events/FormRenderer";
import { formatRoundDeadline } from "@/lib/admissions/window";
import { ADMISSION_PRIVATE_FIELD_LIMITS } from "@/lib/firestore/admissionApplicationPrivate";
import {
  EMPTY_APPLICATION_PROGRAMME_PREFERENCE,
  type ApplicationProgrammePreference,
} from "@/lib/firestore/admissionApplications";
import type { RsvpAnswer } from "@/lib/firestore/events";
import ApplicationPrivacyNotice from "./ApplicationPrivacyNotice";
import AvailabilityGrid from "./AvailabilityGrid";
import DraftSaveBar from "./DraftSaveBar";
import ProgrammePreference from "./ProgrammePreference";
import {
  ApplyApiError,
  WITHDRAW_WORD,
  fetchApplyContext,
  saveDraft,
  startApplication,
  submitApplication,
  submitStage,
  withdrawApplication,
  type ApplicantApplication,
  type ApplicantRound,
  type ApplicantStage,
} from "./applyClient";
import {
  columnsToMask,
  emptyColumns,
  maskToColumns,
  type DayColumns,
} from "./availabilityModel";
import styles from "./ApplyFlow.module.css";

/**
 * The applicant's whole journey on one round, from "start an application" to
 * "here is what you sent us".
 *
 * ## Why it is one island rather than a page per state
 *
 * There are seven states (no row yet, draft, submitted, a later stage open,
 * withdrawn while open, withdrawn after close, decided) and every one of them
 * is reachable from the same URL, because the URL is the round. Splitting them
 * across routes would mean a redirect on every transition, which on a phone at
 * a fair is a full page load between "Submit" and the confirmation.
 *
 * ## The draft is on the server, and this component never pretends otherwise
 *
 * Everything typed here lives in React state until a save, and the save bar
 * says so at all times: dirty, saving, or saved at a time. There is no
 * localStorage mirror, deliberately. Two copies of an application with no
 * reconciliation is how somebody's laptop draft silently overwrites the newer
 * one they wrote on their phone, and this form is the one place in the site
 * where that would cost a person a place on a programme.
 *
 * ## reCAPTCHA is minted per action
 *
 * The token is executed at the moment the button is pressed, never at page
 * load. Google's tokens go stale in about two minutes and an applicant writing
 * a five-hundred-word answer is well past that, so a page-load token would
 * fail the very submission it was there to protect. The autosave deliberately
 * carries no token at all (see `applyRoutes.ts`).
 *
 * ## Everything a member typed renders through MemberText
 *
 * The view-only rendering after submit shows the applicant their own answers.
 * They are member-authored strings, so they go through `MemberText`, which
 * renders a text node and nothing else.
 */

type Props = {
  round: ApplicantRound;
  stages: ApplicantStage[];
  application: ApplicantApplication | null;
  /** Rendered above the form for a role-pending account. */
  pendingNote?: boolean;
};

type Answers = Record<string, Record<string, RsvpAnswer>>;

function releaseLabel(stage: Extract<ApplicantStage, { released: false }>): string {
  if (!stage.releasesAt) return "opens when the round does";
  const at = new Date(stage.releasesAt);
  if (Number.isNaN(at.getTime())) return "opens later in the window";
  return `opens ${formatRoundDeadline(at)}`;
}

/** One stored answer as a sentence, for the view-only rendering. */
function answerText(value: RsvpAnswer | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  const other = value.other?.trim();
  return [...value.checked, other ? `Other: ${other}` : ""].filter(Boolean).join(", ");
}

export default function ApplyFlow({
  round,
  stages: initialStages,
  application: initialApplication,
  pendingNote,
}: Props) {
  const [stages, setStages] = useState(initialStages);
  const [application, setApplication] = useState(initialApplication);

  const [answers, setAnswers] = useState<Answers>(initialApplication?.stageAnswers ?? {});
  const [columns, setColumns] = useState<DayColumns>(() =>
    initialApplication
      ? maskToColumns(initialApplication.availability, round.availabilityGrid)
      : emptyColumns(round.availabilityGrid),
  );
  const [preference, setPreference] = useState<ApplicationProgrammePreference>(
    initialApplication?.programmePreference ?? {
      ...EMPTY_APPLICATION_PROGRAMME_PREFERENCE,
    },
  );
  const [access, setAccess] = useState(initialApplication?.accessRequirements ?? "");

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(
    initialApplication?.updatedAt ?? null,
  );
  const [busy, setBusy] = useState<"" | "start" | "submit" | "withdraw" | "stage">("");
  const [error, setError] = useState("");
  /**
   * The server's per-question message, scoped to the stage it belongs to.
   *
   * Both halves matter. Question ids are unique within a stage but nothing
   * stops two stages of the same round using the same id, so an unscoped map
   * would hang "Why this? is required" under the identically-named question on
   * a stage the applicant has not even opened.
   */
  const [fieldError, setFieldError] = useState<{
    stageId: string | null;
    byQuestion: Record<string, string>;
  }>({ stageId: null, byQuestion: {} });
  const [withdrawTyped, setWithdrawTyped] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);

  const recaptcha = useRef<RecaptchaHandle | null>(null);

  const windowOpen = round.windowState === "open";
  const status = application?.status ?? null;
  const isDraft = status === "draft";
  const released = stages.filter(
    (stage): stage is Extract<ApplicantStage, { released: true }> => stage.released,
  );

  /**
   * Mint a token for THIS action. A null token is honest rather than an error:
   * with no site key configured (local dev, or before the key is provisioned)
   * the widget yields nothing, and the server decides what that means. In
   * production with no secret it fails closed, which is the documented and
   * intended behaviour of `verifyRecaptcha`.
   */
  async function token(): Promise<string | null> {
    if (!RECAPTCHA_ENABLED) return null;
    return (await recaptcha.current?.execute()) ?? null;
  }

  function adopt(next: ApplicantApplication | null) {
    setApplication(next);
    if (!next) return;
    setAnswers(next.stageAnswers);
    setColumns(maskToColumns(next.availability, round.availabilityGrid));
    setPreference(next.programmePreference);
    setAccess(next.accessRequirements);
    setDirty(false);
    setSavedAt(next.updatedAt);
  }

  function surface(err: unknown) {
    if (err instanceof ApplyApiError) {
      setError(err.message);
      if (err.questionId) {
        setFieldError({
          stageId: err.stageId ?? null,
          byQuestion: { [err.questionId]: err.message },
        });
      }
      return;
    }
    console.error("[apply]", err);
    setError("Something went wrong. Please try again.");
  }

  async function onStart() {
    setBusy("start");
    setError("");
    try {
      const result = await startApplication(round.id, await token());
      adopt(result.application);
    } catch (err) {
      // A 409 means the row is already there. The server sends it back, so a
      // double tap OPENS the draft instead of showing a failure about a form
      // the applicant is looking at.
      if (err instanceof ApplyApiError && err.status === 409 && err.application) {
        adopt(err.application);
      } else {
        surface(err);
      }
    } finally {
      setBusy("");
    }
  }

  async function onSave(): Promise<boolean> {
    if (!isDraft) return false;
    setSaving(true);
    setError("");
    setFieldError({ stageId: null, byQuestion: {} });
    try {
      const result = await saveDraft(round.id, {
        stageAnswers: answers,
        availability: columnsToMask(columns, round.availabilityGrid),
        programmePreference: preference,
        accessRequirements: access,
      });
      setApplication(result.application);
      setSavedAt(result.savedAt);
      setDirty(false);
      return true;
    } catch (err) {
      surface(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function onSubmit() {
    setBusy("submit");
    setError("");
    setFieldError({ stageId: null, byQuestion: {} });
    try {
      // Save FIRST, always. The submit route validates what is stored, not
      // what is on screen, so submitting without saving would review a version
      // the applicant has since edited.
      if (dirty && !(await onSave())) return;
      const result = await submitApplication(round.id, await token());
      adopt(result.application);
    } catch (err) {
      surface(err);
    } finally {
      setBusy("");
    }
  }

  async function onSubmitStage(stageId: string) {
    setBusy("stage");
    setError("");
    setFieldError({ stageId: null, byQuestion: {} });
    try {
      const result = await submitStage(
        round.id,
        stageId,
        answers[stageId] ?? {},
        await token(),
      );
      adopt(result.application);
    } catch (err) {
      surface(err);
    } finally {
      setBusy("");
    }
  }

  async function onWithdraw() {
    setBusy("withdraw");
    setError("");
    try {
      const result = await withdrawApplication(round.id, withdrawTyped);
      adopt(result.application);
      setShowWithdraw(false);
      setWithdrawTyped("");
    } catch (err) {
      surface(err);
    } finally {
      setBusy("");
    }
  }

  async function onRefresh() {
    setError("");
    try {
      const fresh = await fetchApplyContext(round.id);
      setStages(fresh.stages);
      adopt(fresh.application);
    } catch (err) {
      surface(err);
    }
  }

  // -------------------------------------------------------------------------
  // Shared pieces
  // -------------------------------------------------------------------------

  const stageStrip =
    stages.length > 1 ? (
      <ol className={styles.strip}>
        {stages.map((stage) => {
          const frozen = Boolean(application?.stageSubmittedAt?.[stage.id]);
          return (
            <li
              key={stage.id}
              className={styles.stripItem}
              data-state={frozen ? "done" : stage.released ? "open" : "locked"}
            >
              <span className={styles.stripLabel}>{stage.label}</span>
              <span className={styles.stripState}>
                {frozen
                  ? "Submitted"
                  : stage.released
                    ? "Open now"
                    : releaseLabel(stage)}
              </span>
            </li>
          );
        })}
      </ol>
    ) : null;

  const errorNote = error ? (
    <p className={styles.error} role="alert">
      {error}
    </p>
  ) : null;

  // -------------------------------------------------------------------------
  // No row yet
  // -------------------------------------------------------------------------

  if (!application) {
    return (
      <div className={styles.wrap}>
        {stageStrip}
        <Card padding="lg" className={styles.card}>
          <h2 className={styles.cardTitle}>
            {windowOpen ? "Start your application" : "Nothing to fill in yet"}
          </h2>
          <p className={styles.body}>
            {windowOpen
              ? "Your answers save to your account as you write them, so you can stop, close this and come back. Nothing is sent to us until you press Submit."
              : round.windowState === "not-yet"
                ? round.opensAt
                  ? `Applications open ${formatRoundDeadline(new Date(round.opensAt))}.`
                  : "Applications open shortly."
                : "Applications for this round have closed."}
          </p>
          {windowOpen ? (
            <>
              <Button type="button" onClick={() => void onStart()} disabled={busy === "start"}>
                {busy === "start" ? "Starting" : "Start your application"}
              </Button>
              {errorNote}
            </>
          ) : (
            errorNote
          )}
        </Card>
        <ApplicationPrivacyNotice className={styles.privacy} />
        <RecaptchaInvisible ref={recaptcha} />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Withdrawn
  // -------------------------------------------------------------------------

  if (status === "withdrawn") {
    return (
      <div className={styles.wrap}>
        {stageStrip}
        <Card padding="lg" className={styles.card}>
          <h2 className={styles.cardTitle}>You withdrew this application</h2>
          <p className={styles.body}>
            {windowOpen
              ? "Everything you wrote is still here. Starting again picks up exactly where you left off, and you can submit any time before the deadline."
              : "The window has closed, so this one stays withdrawn. If something changed, reply to any email from us and we will take a look."}
          </p>
          {windowOpen ? (
            <Button type="button" onClick={() => void onStart()} disabled={busy === "start"}>
              {busy === "start" ? "Reopening" : "Pick it back up"}
            </Button>
          ) : null}
          {errorNote}
        </Card>
        <RecaptchaInvisible ref={recaptcha} />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Draft (editable) and everything after it (view-only)
  // -------------------------------------------------------------------------

  const editable = isDraft && windowOpen;

  return (
    <div className={styles.wrap}>
      {pendingNote && editable ? (
        <p className={styles.pending}>
          Your membership is still with the committee, which is fine. This
          application and that decision are looked at separately.
        </p>
      ) : null}

      {stageStrip}

      {!editable ? (
        <Card padding="lg" className={styles.card}>
          <h2 className={styles.cardTitle}>
            {status === "submitted" ? "Your application is in" : "Your application"}
          </h2>
          <p className={styles.body}>
            {status === "submitted"
              ? round.decisionsByDate
                ? `We will be in touch by ${round.decisionsByDate}. You can read what you sent below.`
                : "We will be in touch once decisions are made. You can read what you sent below."
              : "This is what you sent us."}
          </p>
          {!windowOpen && isDraft ? (
            <p className={styles.body}>
              The window closed before this was submitted, so it stays a draft.
              Everything you wrote is still here.
            </p>
          ) : null}
        </Card>
      ) : null}

      {released.map((stage) => {
        const frozen = Boolean(application.stageSubmittedAt?.[stage.id]);
        const questions = stage.questions ?? [];
        const stageAnswers = answers[stage.id] ?? {};
        // A later stage is answerable once the first submission is in, even
        // though the application as a whole is no longer a draft.
        const stageEditable = editable || (status === "submitted" && !frozen);
        return (
          <section key={stage.id} className={styles.stage}>
            <h2 className={styles.stageTitle}>{stage.label}</h2>
            {stage.intro ? <MemberText text={stage.intro} className={styles.intro} /> : null}

            {stageEditable ? (
              <FormRenderer
                questions={questions}
                answers={stageAnswers}
                errors={
                  fieldError.stageId === null || fieldError.stageId === stage.id
                    ? fieldError.byQuestion
                    : undefined
                }
                onChange={(next) => {
                  setAnswers((prev) => ({ ...prev, [stage.id]: next }));
                  setDirty(true);
                }}
              />
            ) : (
              <dl className={styles.review}>
                {questions.map((question) => (
                  <div key={question.id} className={styles.reviewRow}>
                    <dt className={styles.reviewLabel}>{question.label}</dt>
                    <dd className={styles.reviewValue}>
                      {answerText(stageAnswers[question.id]) ? (
                        <MemberText text={answerText(stageAnswers[question.id])} />
                      ) : (
                        <span className={styles.blank}>Not answered</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {status === "submitted" && !frozen ? (
              <div className={styles.stageActions}>
                <Button
                  type="button"
                  onClick={() => void onSubmitStage(stage.id)}
                  disabled={busy === "stage"}
                >
                  {busy === "stage" ? "Sending" : `Submit ${stage.label}`}
                </Button>
                <p className={styles.note}>
                  This part is sent on its own. There is no draft for it, so
                  finish your answers before you press this.
                </p>
              </div>
            ) : null}
          </section>
        );
      })}

      {round.programmePreference.enabled ? (
        <section className={styles.stage}>
          <h2 className={styles.stageTitle}>What you would like to be considered for</h2>
          <ProgrammePreference
            section={round.programmePreference}
            value={preference}
            readOnly={!editable}
            onChange={(next) => {
              setPreference(next);
              setDirty(true);
            }}
          />
        </section>
      ) : null}

      <section className={styles.stage}>
        <h2 className={styles.stageTitle}>When you could be there</h2>
        <p className={styles.note}>
          In-person sessions, Nottingham. Mark everything that could work, not
          only your ideal: the more you mark, the more likely we can put you in
          a group that fits. We cannot promise to suit everybody.
        </p>
        <AvailabilityGrid
          grid={round.availabilityGrid}
          columns={columns}
          readOnly={!editable}
          onChange={(next) => {
            setColumns(next);
            setDirty(true);
          }}
        />
      </section>

      <section className={styles.stage}>
        <h2 className={styles.stageTitle}>Access requirements</h2>
        <p className={styles.note}>
          {round.accessRequirementsPrompt ||
            "Is there anything we should know so you can take part fully? Rooms, timing, materials, anything at all."}
        </p>
        <p className={styles.note}>
          <strong>This box is never scored.</strong> It is stored apart from the
          rest of your application, reviewers never see it, and only the person
          making the final decision and site admins can open it. Leaving it
          blank does not count against you.
        </p>
        {editable ? (
          <CountedTextarea
            value={access}
            max={ADMISSION_PRIVATE_FIELD_LIMITS.accessRequirements}
            rows={4}
            aria-label="Access requirements"
            onChange={(event) => {
              setAccess(event.target.value);
              setDirty(true);
            }}
          />
        ) : access ? (
          <MemberText text={access} />
        ) : (
          <p className={styles.blank}>You did not add anything here.</p>
        )}
      </section>

      <ApplicationPrivacyNotice className={styles.privacy} />

      {errorNote}

      {editable ? (
        <>
          <DraftSaveBar
            dirty={dirty}
            saving={saving}
            savedAt={savedAt}
            onSave={onSave}
            disabled={busy !== ""}
          />
          <div className={styles.submitRow}>
            <Button
              type="button"
              onClick={() => void onSubmit()}
              disabled={busy === "submit" || saving}
            >
              {busy === "submit" ? "Submitting" : "Submit application"}
            </Button>
            <p className={styles.note}>
              {round.closesAt
                ? `You can edit and resubmit until ${formatRoundDeadline(new Date(round.closesAt))} by withdrawing and picking it back up.`
                : "Once it is in you can still withdraw it while the window is open."}
            </p>
          </div>
        </>
      ) : null}

      {status === "draft" || status === "submitted" ? (
        <section className={styles.withdraw}>
          {!showWithdraw ? (
            <button
              type="button"
              className={styles.withdrawLink}
              onClick={() => setShowWithdraw(true)}
            >
              Withdraw this application
            </button>
          ) : (
            <div className={styles.withdrawBox}>
              <p className={styles.note}>
                {windowOpen
                  ? `Withdrawing takes you out of the queue. Nothing you wrote is deleted, and you can pick it back up while the window is open. Type ${WITHDRAW_WORD} to confirm.`
                  : `The window has closed, so withdrawing now is final. Type ${WITHDRAW_WORD} to confirm.`}
              </p>
              <Input
                value={withdrawTyped}
                aria-label={`Type ${WITHDRAW_WORD} to confirm`}
                placeholder={WITHDRAW_WORD}
                onChange={(event) => setWithdrawTyped(event.target.value)}
              />
              <div className={styles.withdrawActions}>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => void onWithdraw()}
                  disabled={
                    busy === "withdraw" ||
                    withdrawTyped.trim().toUpperCase() !== WITHDRAW_WORD
                  }
                >
                  {busy === "withdraw" ? "Withdrawing" : "Withdraw"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowWithdraw(false);
                    setWithdrawTyped("");
                  }}
                >
                  Keep it
                </Button>
              </div>
            </div>
          )}
        </section>
      ) : null}

      <p className={styles.refresh}>
        <button type="button" className={styles.withdrawLink} onClick={() => void onRefresh()}>
          Reload from the server
        </button>
      </p>

      <RecaptchaInvisible ref={recaptcha} />
    </div>
  );
}
