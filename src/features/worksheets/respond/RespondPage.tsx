"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Chip, { type ChipTone } from "@/components/ui/Chip";
import EmptyState from "@/components/ui/EmptyState";
import Modal from "@/components/ui/Modal";
import ProgressBar from "@/components/ui/ProgressBar";
import SavedFlash from "@/components/ui/SavedFlash";
import Skeleton from "@/components/ui/Skeleton";
import { useAuth } from "@/auth/AuthProvider";
import { useTaskRoster } from "@/features/tasks/hooks/useTaskRoster";
import { useCirculation } from "@/features/worksheets/hooks/useCirculation";
import { useResponse } from "@/features/worksheets/hooks/useResponse";
import {
  RESPONSE_STATE_LABELS,
  isTerminalResponseState,
  type ResponseState,
} from "@/lib/firestore/circulations";
import {
  computeProgress,
  pagesOf,
  validateAnswer,
  validateSubmission,
  type SubmissionProblem,
  type WorksheetAnswer,
  type WorksheetItem,
  type WorksheetQuestion,
} from "@/lib/firestore/worksheets";
import QuestionBody from "./QuestionBody";
import SaveButton from "./SaveButton";
import WorksheetQuestionField from "./WorksheetQuestionField";
import {
  clampPageIndex,
  firstPageWithProblem,
  pageState,
  saveErrorSentence,
} from "./respondHelpers";
import { useAnswerAutosave } from "./useAnswerAutosave";
import { useResponseActivity } from "./useResponseActivity";
import styles from "./RespondPage.module.css";

/**
 * ONE RECIPIENT ANSWERING ONE CIRCULATION.
 *
 * ── THE RULES DECIDE WHO GETS IN, NOT A LAYOUT GATE ─────────────────────────
 * There is no role check above this page beyond the authed shell. A recipient
 * proves themselves with the document that exists for exactly one reason,
 * their own response, and the circulation's read rule is an `exists()` on it.
 * So somebody who is not a recipient gets a refusal on both reads and lands on
 * the not-found state below. Adding a role gate would be a second, weaker copy
 * of that check: recipients are committee members today and need not be
 * tomorrow (docs/worksheets.md: "a recipient is a response document and a
 * task, whatever their role").
 *
 * ── WHAT IS LOCAL AND WHAT IS THE DOCUMENT ──────────────────────────────────
 * `answers` is local state, seeded from the response and authoritative for
 * everything on screen while the recipient types: the autosave echoing back
 * through the listener must never re-seed mid-sentence. It is re-seeded on
 * exactly one transition, into a FROZEN state, which is where the document
 * becomes the authority again (the submit route re-derives progress and the
 * page turns read-only).
 *
 * ── SAVING IS THREE THINGS, IN ONE ORDER ────────────────────────────────────
 * Autosave (debounced, per changed question), Save (flush now), and Submit
 * (flush, then POST). Submit flushes FIRST for the reason ExerciseSubmit
 * spells out: a pending 900ms write landing after the submit would overwrite
 * the submitted answers with the older draft, and the document would then
 * disagree with the page under a green banner.
 *
 * ── VALIDATION IS THE ROUTE'S, RUN EARLY ────────────────────────────────────
 * `validateSubmission` is the shared model function the submit route runs
 * against the same items, so a submission this page allows is one the route
 * accepts. Running it here buys the recipient the page number of their first
 * mistake instead of a sentence about a question they cannot see.
 */

/** Stable empty array so the memos below do not churn while data loads. */
const NO_ITEMS: WorksheetItem[] = [];

const STATE_TONE: Record<ResponseState, ChipTone> = {
  "not-opened": "neutral",
  started: "accent",
  submitted: "success",
  reviewed: "success",
};

/** Client-rendered only (the page has no data until the listeners fire), so
 *  there is no server/client locale skew to guard against. */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * A refusal that still knows which one it was: 400 carries the per-question
 * problems, 409 means the response is frozen or the circulation is closed and
 * there is nothing to retry.
 */
class SubmitError extends Error {
  readonly status: number;
  readonly problems: SubmissionProblem[];
  constructor(message: string, status: number, problems: SubmissionProblem[]) {
    super(message);
    this.name = "SubmitError";
    this.status = status;
    this.problems = problems;
  }
}

async function postSubmit(circulationId: string): Promise<void> {
  const res = await fetch(
    `/api/worksheets/circulations/${encodeURIComponent(circulationId)}/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string; problems?: SubmissionProblem[] }
    | null;
  if (!res.ok) {
    throw new SubmitError(
      body?.error ?? `Your answers were not submitted (${res.status}).`,
      res.status,
      Array.isArray(body?.problems) ? body.problems : [],
    );
  }
}

async function uploadAnswerImage(
  circulationId: string,
  questionId: string,
  file: File,
): Promise<{ url: string; storagePath: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("questionId", questionId);
  const res = await fetch(
    `/api/worksheets/circulations/${encodeURIComponent(circulationId)}/upload`,
    { method: "POST", body: form },
  );
  const body = (await res.json().catch(() => null)) as
    | { url?: string; storagePath?: string; error?: string }
    | null;
  if (!res.ok || !body?.url || !body?.storagePath) {
    throw new Error(body?.error ?? `That image did not upload (${res.status}).`);
  }
  return { url: body.url, storagePath: body.storagePath };
}

export default function RespondPage({ circulationId }: { circulationId: string }) {
  const { user, authResolved } = useAuth();
  const uid = user?.uid ?? null;

  const {
    circulation,
    loading: circulationLoading,
    error: circulationError,
  } = useCirculation(circulationId);
  const { response, loading: responseLoading, error: responseError } = useResponse(
    circulationId,
    uid,
  );
  // Names of the people on tasks this viewer is on, which for a recipient is
  // their own reviewers. The users collection is never read from here.
  const { users } = useTaskRoster();

  const [answers, setAnswers] = useState<Record<string, WorksheetAnswer>>({});
  const [seededKey, setSeededKey] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [problems, setProblems] = useState<SubmissionProblem[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const items = circulation?.items ?? NO_ITEMS;
  const pages = useMemo(() => pagesOf(items), [items]);
  const state: ResponseState = response?.state ?? "not-opened";
  const frozen = isTerminalResponseState(state);
  const closed = circulation?.status === "closed";
  /** Answering is open: there is a response, and it is not frozen. */
  const canEdit = Boolean(response) && !frozen;

  /**
   * Seed the local answers from the document, and re-seed on exactly one
   * transition: into a frozen state. Adjusting state during render is the
   * idiom this repo uses for "a late fetch must not clobber a draft" (see
   * ExerciseSubmit); an effect would paint the empty form first.
   */
  const seedKey = response ? `${response.id}:${frozen ? "frozen" : "live"}` : null;
  if (response && seedKey !== seededKey) {
    setSeededKey(seedKey);
    setAnswers(response.answers);
  }

  /**
   * The answers as they are NOW, for handlers that dispatch a write rather
   * than render: the click that submits must send what the recipient is
   * looking at, not what its closure captured.
   */
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const safePage = clampPageIndex(pageIndex, pages.length);
  const progress = useMemo(() => computeProgress(items, answers), [items, answers]);
  /**
   * The same two numbers for THIS page only. The whole-worksheet count is the
   * one the document stores and the staff read; this one never leaves the
   * browser, and it answers the question somebody actually has in front of a
   * sticky Next button: is there anything left on this screen?
   */
  const thisPage = useMemo(
    () => pageState(pages[safePage] ?? NO_ITEMS, answers),
    [answers, pages, safePage],
  );

  const autosave = useAnswerAutosave({ circulationId, uid, items, enabled: canEdit });
  useResponseActivity({
    circulationId,
    uid,
    response,
    pageIndex: safePage,
    enabled: canEdit,
  });

  const {
    push: pushAnswers,
    flush: flushAnswers,
    hasUnsavedChanges: answersUnsaved,
  } = autosave;

  const onAnswerChange = useCallback(
    (questionId: string, next: WorksheetAnswer) => {
      // Merged from the ref rather than from a state updater: React may invoke
      // an updater twice, and pushing a write from inside one would queue the
      // same change to the network twice.
      const merged = { ...answersRef.current, [questionId]: next };
      answersRef.current = merged;
      setAnswers(merged);
      pushAnswers(merged, questionId);
      // A submission problem is about the value at submit time. Editing the
      // answer makes it stale, so it goes rather than sitting under a box the
      // recipient has just fixed.
      setProblems((prev) => prev.filter((p) => p.questionId !== questionId));
    },
    [pushAnswers],
  );

  const goToPage = useCallback(
    (next: number) => {
      const target = clampPageIndex(next, pages.length);
      setPageIndex(target);
      // Land the pending write before the page changes: the fields that hold
      // it are about to unmount, and their blur may never fire.
      void flushAnswers();
      window.scrollTo(0, 0);
    },
    [flushAnswers, pages.length],
  );

  const onUploadImage = useCallback(
    (file: File, questionId: string) => uploadAnswerImage(circulationId, questionId, file),
    [circulationId],
  );

  /**
   * Store an answer NOW rather than in 900ms, for a change that cost the
   * recipient something to make. An uploaded image is already in the bucket by
   * the time it reaches the answer, so a tab closed inside the debounce window
   * would leave the blob there with nothing pointing at it and the recipient
   * looking at a question they thought they had answered.
   */
  const commitNow = useCallback(() => {
    void flushAnswers();
  }, [flushAnswers]);

  const jumpToProblems = useCallback(
    (found: SubmissionProblem[]) => {
      setProblems(found);
      const target = firstPageWithProblem(pages, found);
      if (target >= 0) {
        setPageIndex(target);
        window.scrollTo(0, 0);
      }
    },
    [pages],
  );

  function onSubmitClick() {
    const found = validateSubmission(items, answersRef.current);
    if (found.length > 0) {
      setSubmitError(null);
      jumpToProblems(found);
      return;
    }
    setProblems([]);
    setSubmitError(null);
    setConfirming(true);
  }

  async function confirmSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Everything pending lands first, or its timer fires after the submit
      // and overwrites the submitted answers with the older draft.
      await flushAnswers();
      // And it has to have LANDED. `flush()` resolves the same way whether its
      // write was stored or refused (the debouncer swallows the throw and puts
      // the failure in `state`), while `validateSubmission` below runs against
      // what is on SCREEN and the route runs against what is in the DOCUMENT.
      // Posting past a refused write therefore freezes the response around
      // answers the recipient can still read and nobody else can, and only an
      // admin unfreeze gets them out of it.
      if (answersUnsaved()) {
        setConfirming(false);
        setSubmitError(
          "Your answers were not submitted, because the last thing you wrote is not stored yet. Press Save, and submit again once it says Saved.",
        );
        return;
      }
      const found = validateSubmission(items, answersRef.current);
      if (found.length > 0) {
        setConfirming(false);
        jumpToProblems(found);
        return;
      }
      await postSubmit(circulationId);
      // The answers ARE stored, by the route. A standing autosave error would
      // otherwise keep saying they are not.
      autosave.reset();
      setConfirming(false);
      setSubmitError(null);
    } catch (err) {
      setConfirming(false);
      if (err instanceof SubmitError) {
        setSubmitError(err.message);
        if (err.problems.length > 0) jumpToProblems(err.problems);
        return;
      }
      setSubmitError(
        err instanceof Error ? err.message : "Your answers were not submitted.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const reviewerNames = useMemo(() => {
    if (!circulation) return [] as string[];
    return circulation.reviewerUids
      .map((reviewerUid) => users.find((u) => u.uid === reviewerUid)?.displayName)
      .filter((name): name is string => Boolean(name));
  }, [circulation, users]);

  const errorFor = useCallback(
    (question: WorksheetQuestion): string | undefined => {
      const problem = problems.find((p) => p.questionId === question.id);
      if (problem) return problem.message;
      const answer = answers[question.id];
      if (!answer) return undefined;
      // Live, so an over-long answer says so while it is being written rather
      // than at the end of a long worksheet.
      return validateAnswer(question, answer) ?? undefined;
    },
    [answers, problems],
  );

  // ── States before the page proper ─────────────────────────────────────────

  if (!authResolved || circulationLoading || responseLoading) {
    return (
      <div className={styles.root}>
        <Skeleton width="60%" height="2rem" ariaLabel="Loading this worksheet…" />
        <Skeleton height="1rem" lines={3} />
        <Skeleton height="8rem" />
      </div>
    );
  }

  if (!circulation || !response || circulationError || responseError) {
    // One state for "no such circulation", "not a recipient" and "the read was
    // refused". They are the same fact from here, and telling them apart would
    // tell somebody guessing ids which ones exist.
    return (
      <EmptyState
        title="This worksheet is not for you or no longer exists"
        body="If you were expecting to answer something, open it from the task on your board."
        action={<Link href="/tasks">Go to your tasks</Link>}
      />
    );
  }

  if (pages.length === 0) {
    return (
      <EmptyState
        title="There is nothing to answer here yet"
        body="Whoever sent this has not put any questions in it. They will let you know when there are some."
        action={<Link href="/tasks">Go to your tasks</Link>}
      />
    );
  }

  const page = pages[safePage];
  const onLastPage = safePage === pages.length - 1;
  const returned = response.returned;
  const saveError = autosave.state === "error" ? autosave.error : null;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>{circulation.title}</h1>
        {circulation.description && (
          <p className={styles.description}>{circulation.description}</p>
        )}
        <div className={styles.metaRow}>
          <Chip tone={STATE_TONE[state]} size="sm">
            {RESPONSE_STATE_LABELS[state]}
          </Chip>
          {circulation.dueDate && <span>Due {formatDate(circulation.dueDate)}</span>}
          {reviewerNames.length > 0 && (
            <span>
              {reviewerNames.length === 1 ? "Your reviewer" : "Your reviewers"}:{" "}
              {reviewerNames.join(", ")}
            </span>
          )}
          {response.activity.firstOpenedAt && (
            <span>You first opened this on {formatDate(response.activity.firstOpenedAt)}</span>
          )}
        </div>
      </header>

      {frozen && response.submittedAt && (
        <p className={`${styles.banner} ${styles.bannerDone}`} role="status">
          Submitted on {formatDate(response.submittedAt)}.{" "}
          {state === "reviewed"
            ? "Your reviewers have returned their feedback below."
            : "You can read your answers here, but not change them."}
        </p>
      )}

      {!frozen && closed && (
        <p className={`${styles.banner} ${styles.bannerNotice}`} role="status">
          This worksheet has been closed, so it is no longer taking submissions. Anything
          you write is still saved, but you will need to ask whoever sent it to reopen it.
        </p>
      )}

      <div className={styles.progressRow}>
        <ProgressBar
          value={progress.answered}
          max={progress.total}
          showLabel
          animateOnMount
          ariaLabel="Questions answered"
        />
        <p className={styles.progressMeta}>
          Page {safePage + 1} of {pages.length} · {progress.answered} of {progress.total}{" "}
          answered
        </p>
        {/* Only worth saying when there is more than one page: on a single-page
            worksheet it is the line above, twice. */}
        {pages.length > 1 && thisPage.total > 0 && (
          <p className={styles.pageMeta}>
            {thisPage.answered} of {thisPage.total} answered on this page
            {thisPage.requiredOutstanding > 0 &&
              ` · ${thisPage.requiredOutstanding} required ${
                thisPage.requiredOutstanding === 1 ? "question" : "questions"
              } still to do`}
          </p>
        )}
      </div>

      {/*
        onBlur rather than a handler per field: React's onBlur is focusout, so
        it fires here whenever focus leaves any control inside the page, which
        is precisely when a half-typed answer should be written.
      */}
      <div className={styles.page} onBlur={() => void flushAnswers()}>
        {page.map((item) => {
          if (item.kind === "section") {
            return (
              <section key={item.id} className={styles.section}>
                <h2 className={styles.sectionHeading}>{item.heading}</h2>
                <QuestionBody body={item.body} />
              </section>
            );
          }
          if (item.kind === "pageBreak") return null;
          const feedback = returned?.perQuestion[item.id]?.feedback;
          return (
            <div key={item.id} className={styles.question}>
              <h2 className={styles.questionTitle}>
                {item.title}
                {item.required && (
                  <span className={styles.required} aria-hidden="true">
                    {" "}
                    *
                  </span>
                )}
                {item.required && <span className="visually-hidden"> (required)</span>}
              </h2>
              <QuestionBody body={item.body} />
              <WorksheetQuestionField
                question={item}
                answer={answers[item.id]}
                onChange={(next) => onAnswerChange(item.id, next)}
                disabled={!canEdit}
                error={errorFor(item)}
                onUploadImage={canEdit ? onUploadImage : undefined}
                onCommit={canEdit ? commitNow : undefined}
              />
              {feedback && (
                <div className={styles.feedback}>
                  <p className={styles.feedbackHead}>Feedback</p>
                  <p className={styles.feedbackText}>{feedback}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The last page only: it is feedback on the whole worksheet, and
          repeating it under every page would read as four separate remarks. */}
      {onLastPage && returned?.overall && (
        <div className={styles.feedback}>
          <p className={styles.feedbackHead}>Overall feedback</p>
          <p className={styles.feedbackText}>{returned.overall}</p>
        </div>
      )}

      {saveError && (
        // Sticky by design: an autosave failure is silent by nature, and the
        // one signal it has must not blink. `alert` rather than `status`,
        // because losing what you just typed is more urgent than anything else
        // this page announces, and the sentence leads with what to do about it
        // rather than with the SDK's own words.
        <p className={styles.errorLine} role="alert">
          {saveErrorSentence(saveError)}
        </p>
      )}
      {submitError && (
        <p className={styles.errorLine} role="alert">
          {submitError}
        </p>
      )}
      {problems.length > 0 && (
        <p className={styles.errorLine} role="alert">
          {problems.length === 1
            ? "One question still needs attention."
            : `${problems.length} questions still need attention.`}{" "}
          They are marked below.
        </p>
      )}

      {/* Beside the button rather than only in the banner at the top: on a
          four-page worksheet the reason Submit is unavailable is several
          screens away from the button it is greying out. */}
      {canEdit && onLastPage && closed && (
        <p className={styles.barNote}>
          Submit is unavailable while this worksheet is closed. Ask whoever sent it to
          reopen it, and everything you have written will still be here.
        </p>
      )}

      <div className={styles.bar}>
        <Button
          variant="ghost"
          onClick={() => goToPage(safePage - 1)}
          disabled={safePage === 0}
        >
          Previous
        </Button>
        <div className={styles.barSpacer}>
          <SavedFlash state={autosave.state} />
        </div>
        <div className={styles.barActions}>
          {canEdit && (
            <SaveButton state={autosave.state} onSave={() => void flushAnswers()} />
          )}
          {onLastPage ? (
            canEdit && (
              <Button onClick={onSubmitClick} disabled={submitting || closed}>
                Submit
              </Button>
            )
          ) : (
            <Button variant="secondary" onClick={() => goToPage(safePage + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>

      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(false)}
          ariaLabel="Submit your answers"
          width="sm"
        >
          <div className={styles.confirm}>
            <h2 className={styles.confirmTitle}>Submit your answers?</h2>
            <p className={styles.confirmBody}>
              {circulation.reviewConfig.returnToRecipient
                ? "Your reviewers will be told, and you will not be able to change your answers afterwards."
                : "You will not be able to change your answers afterwards."}
            </p>
            <div className={styles.confirmActions}>
              <Button
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={submitting}
              >
                Keep working
              </Button>
              <Button onClick={() => void confirmSubmit()} disabled={submitting}>
                {submitting ? "Submitting…" : "Submit"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
