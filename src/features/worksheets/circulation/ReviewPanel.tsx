"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import MemberName, { MEMBER_NAME_FALLBACK } from "@/components/ui/MemberName";
import MemberText from "@/components/ui/MemberText";
import SavedFlash, { type SaveState } from "@/components/ui/SavedFlash";
import { useDebouncedWrite } from "@/hooks/useDebouncedWrite";
import {
  CIRCULATION_LIMITS,
  type CirculationDoc,
  type ResponseDoc,
} from "@/lib/firestore/circulations";
import { questionsOf } from "@/lib/firestore/worksheets";
import { useReview } from "../hooks/useReview";
import { saveReview, type ReviewDraft } from "../reviewMutations";
import styles from "./ReviewPanel.module.css";

/**
 * The staff side of one response: feedback per question, a score per question,
 * one overall box, and the button that sends the readable half back.
 *
 * ── FOUR TOGGLES DECIDE WHAT IS ON THE SCREEN ───────────────────────────────
 * `perQuestionFeedback`, `perQuestionScoring` and `overallFeedback` each draw
 * their own control and nothing else; `returnToRecipient` draws the button, and
 * when it is off it draws a sentence saying so instead. A panel that showed a
 * disabled Return button on a circulation that never returns anything would
 * read as a thing somebody had forgotten to switch on.
 *
 * ── SCORES NEVER LEAVE THIS PANEL ───────────────────────────────────────────
 * The score input is labelled "Score (reviewers only)" because that is the only
 * difference between it and the box above it, and a reviewer who does not know
 * it is grading in private will write differently. The guarantee is not this
 * label: it is the review document being staff-read-only, and `ReturnedFeedback`
 * having nowhere to put a score.
 *
 * ── ONE DRAFT, HYDRATED ONCE ────────────────────────────────────────────────
 * The stored review is copied into local state once per response and every
 * later snapshot is ignored, the worksheet editor's pattern and for its reason:
 * the snapshot stream carries back this panel's own writes, and re-seeding the
 * boxes from it would move the caret mid-word. The cost is that a second
 * reviewer's typing is not seen live. Two reviewers on one response is
 * last-write-wins per field either way (there is no lock; see
 * `reviewMutations`), so what is lost is the display of a clash rather than the
 * clash itself, and the panel says as much where it matters: the Return button
 * flushes before it posts.
 *
 * ── THE FLUSH BEFORE THE RETURN IS LOAD-BEARING ─────────────────────────────
 * Feedback is written client-direct on a 900ms debounce and the return route
 * reads the STORED review document, so a sentence typed half a second before
 * the button was pressed is not in the copy that goes back. Every path to the
 * POST awaits the writer first.
 */

type Props = {
  circulation: CirculationDoc;
  response: ResponseDoc;
  /** The viewer, used to say "you" rather than a name they cannot resolve. */
  reviewerUid: string;
  /**
   * The recipient's display name, for the confirmation. Optional because the
   * name resolvers on this page are the caller's, not this component's; without
   * one the confirmation names them the way every other cohort surface does.
   */
  recipientName?: string;
  /**
   * Who returned the feedback, already resolved to a name by the caller, for
   * the read-only line. Optional for the same reason as the one above, and
   * absent it the line simply stops after the date: "by NAISI member" on every
   * returned response would not be a fallback, it would be a sentence that is
   * wrong about a specific person whose name the page above this one holds.
   */
  returnedByName?: string;
};

/** The panel's own copy of one question's boxes. Scores are held as the STRING
 *  the input carries, so a half-typed "1" on the way to "10" is not rounded,
 *  clamped and written back under the reviewer's fingers. */
type EntryDraft = { feedback: string; score: string };
type PanelDraft = { perQuestion: Record<string, EntryDraft>; overall: string };

const EMPTY_ENTRY: EntryDraft = { feedback: "", score: "" };

function scoreToDraft(score: number | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? String(score) : "";
}

function draftToScore(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function ReviewPanel({
  circulation,
  response,
  reviewerUid,
  recipientName,
  returnedByName,
}: Props) {
  const config = circulation.reviewConfig;
  /** Whether either per-question control is on the screen at all. */
  const writesAnything = config.perQuestionFeedback || config.perQuestionScoring;
  const questions = useMemo(() => questionsOf(circulation.items), [circulation.items]);
  const { review, loading, error } = useReview(circulation.id, response.uid);

  const [draft, setDraft] = useState<PanelDraft>({ perQuestion: {}, overall: "" });
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);

  const write = useCallback(
    async (value: PanelDraft) => {
      const perQuestion: ReviewDraft["perQuestion"] = {};
      // EVERY question the panel is showing, empty entries included. Dropping
      // the empty ones would leave a cleared box's old text in the stored map
      // (merge writes field by field), and the return route reads that map.
      //
      // NOTHING when neither per-question control is on the screen, though: a
      // circulation with only the overall box would otherwise store an empty
      // entry per question, one per keystroke in a box that is not about any
      // of them, and `perQuestion` is the map the rules cap at a hundred
      // entries. An empty map merges to no change, so a sender who turns the
      // toggles back on finds the earlier feedback where they left it.
      if (writesAnything) {
        for (const question of questions) {
          const entry = value.perQuestion[question.id] ?? EMPTY_ENTRY;
          perQuestion[question.id] = {
            feedback: entry.feedback,
            score: draftToScore(entry.score),
          };
        }
      }
      await saveReview(circulation.id, response.uid, { perQuestion, overall: value.overall });
    },
    [circulation.id, questions, response.uid, writesAnything],
  );
  const saver = useDebouncedWrite(write);

  // Hydrate during render rather than in an effect: an effect would paint one
  // frame of empty boxes over feedback that has already arrived. Keyed on the
  // response, because this panel is remounted across recipients by a parent
  // that may reuse it.
  const key = `${circulation.id}/${response.uid}`;
  if (!loading && hydratedKey !== key) {
    setHydratedKey(key);
    const perQuestion: Record<string, EntryDraft> = {};
    for (const question of questions) {
      const entry = review?.perQuestion[question.id];
      perQuestion[question.id] = {
        feedback: entry?.feedback ?? "",
        score: scoreToDraft(entry?.score),
      };
    }
    setDraft({ perQuestion, overall: review?.overall ?? "" });
    // A panel reused for a second recipient must not carry the first one's
    // refusal, which would read as a refusal about this person.
    setReturnError(null);
    setReturning(false);
  }

  const readOnly = response.state === "reviewed";
  // Nothing is rendered until the stored notes have arrived, so a reviewer
  // cannot type into a box that is about to be replaced by what is on the
  // server. A refused READ is shown as itself and nothing else: the same rule
  // that hid the notes would refuse the write, and empty boxes would invite
  // somebody to fill them in for no reason.
  const hydrated = hydratedKey === key;

  /**
   * Who to name in the read-only line, or null when nobody can be. The viewer
   * is "you" because a reviewer reading their own name back is the page
   * talking about a stranger; anybody else is named through the resolver the
   * page above holds. Null rather than the member fallback when there is no
   * resolver: "Returned on 6 Sep" is short, and "Returned on 6 Sep by NAISI
   * member" is a sentence that is wrong about a colleague.
   */
  const returnedBy: ReactNode | null = !response.returned
    ? null
    : response.returned.returnedByUid === reviewerUid
      ? "you"
      : returnedByName?.trim()
        ? <MemberName name={returnedByName} />
        : null;

  function entryOf(questionId: string): EntryDraft {
    return draft.perQuestion[questionId] ?? EMPTY_ENTRY;
  }

  function patchEntry(questionId: string, patch: Partial<EntryDraft>) {
    const next: PanelDraft = {
      ...draft,
      perQuestion: {
        ...draft.perQuestion,
        [questionId]: { ...entryOf(questionId), ...patch },
      },
    };
    setDraft(next);
    saver.push(next);
  }

  function patchOverall(value: string) {
    const next: PanelDraft = { ...draft, overall: value };
    setDraft(next);
    saver.push(next);
  }

  /** What the confirmation promises, built from the toggles that are on. */
  function returnSentence(): string {
    const name = recipientName?.trim() || MEMBER_NAME_FALLBACK;
    const parts: string[] = [];
    if (config.perQuestionFeedback) parts.push("Per-question feedback");
    if (config.overallFeedback) parts.push(parts.length ? "overall feedback" : "Overall feedback");
    const scores = config.perQuestionScoring ? " Scores are never sent." : "";
    if (parts.length === 0) {
      return `This circulation has no feedback boxes turned on, so nothing goes to ${name}. Their answers will be marked as reviewed.${scores}`;
    }
    return `${parts.join(" and ")} will be sent to ${name}.${scores}`;
  }

  async function handleReturn() {
    if (returning) return;
    if (!window.confirm(returnSentence())) return;
    setReturning(true);
    setReturnError(null);
    try {
      // Anything typed inside the debounce window goes out FIRST: the route
      // copies the STORED review, not this panel's state.
      await saver.flush();
      const res = await fetch(
        `/api/worksheets/circulations/${encodeURIComponent(circulation.id)}/responses/${encodeURIComponent(response.uid)}/return`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setReturnError(body?.error ?? `Couldn't return that feedback (${res.status}).`);
      }
    } catch (err) {
      setReturnError(err instanceof Error ? err.message : "Couldn't return that feedback.");
    } finally {
      // The response listener flips this panel to its read-only state on its
      // own; clearing the flag here is what stops a failed attempt leaving the
      // button dead.
      setReturning(false);
    }
  }

  const saveState: SaveState = saver.state;

  return (
    <section className={styles.panel} aria-label="Review">
      <header className={styles.head}>
        <h3 className={styles.title}>Review</h3>
        {!readOnly && <SavedFlash state={saveState} />}
      </header>

      {error && (
        <p className={styles.error} role="status">
          Couldn&apos;t open the review notes: {error.message}
        </p>
      )}
      {saveState === "error" && saver.error && (
        <p className={styles.error} role="status">
          That note is not stored: {saver.error.message}
        </p>
      )}

      {!error && !hydrated && (
        <p className={styles.muted}>Loading the review notes…</p>
      )}

      {!error && hydrated && readOnly && (
        <p className={styles.returnedLine}>
          Returned
          {response.returned?.returnedAt
            ? ` on ${formatDay(response.returned.returnedAt)}`
            : ""}
          {returnedBy ? <> by {returnedBy}</> : null}.
        </p>
      )}

      {!error && hydrated && writesAnything && questions.length > 0 && (
        <ol className={styles.questions}>
          {questions.map((question) => {
            const entry = entryOf(question.id);
            return (
              <li key={question.id} className={styles.question}>
                <p className={styles.questionTitle}>{question.title}</p>

                {config.perQuestionFeedback &&
                  (readOnly ? (
                    entry.feedback ? (
                      <MemberText text={entry.feedback} className={styles.readOnlyText} />
                    ) : (
                      <p className={styles.muted}>No feedback on this one.</p>
                    )
                  ) : (
                    <Field id={`review-feedback-${question.id}`} label="Feedback">
                      <CountedTextarea
                        id={`review-feedback-${question.id}`}
                        value={entry.feedback}
                        max={CIRCULATION_LIMITS.feedback}
                        rows={3}
                        onChange={(e) => patchEntry(question.id, { feedback: e.target.value })}
                        onBlur={() => void saver.flush()}
                      />
                    </Field>
                  ))}

                {config.perQuestionScoring &&
                  (readOnly ? (
                    <p className={styles.muted}>
                      Score (reviewers only): {entry.score || "not scored"}
                    </p>
                  ) : (
                    <div className={styles.scoreField}>
                      <Field id={`review-score-${question.id}`} label="Score (reviewers only)">
                        <Input
                          id={`review-score-${question.id}`}
                          type="number"
                          inputMode="numeric"
                          min={CIRCULATION_LIMITS.scoreMin}
                          max={CIRCULATION_LIMITS.scoreMax}
                          step={1}
                          value={entry.score}
                          onChange={(e) => patchEntry(question.id, { score: e.target.value })}
                          onBlur={() => void saver.flush()}
                        />
                      </Field>
                    </div>
                  ))}
              </li>
            );
          })}
        </ol>
      )}

      {!error && hydrated && config.overallFeedback &&
        (readOnly ? (
          <div className={styles.overallRead}>
            <p className={styles.overallHead}>Overall feedback</p>
            {draft.overall ? (
              <MemberText text={draft.overall} className={styles.readOnlyText} />
            ) : (
              <p className={styles.muted}>Nothing was written here.</p>
            )}
          </div>
        ) : (
          <Field
            id="review-overall"
            label="Overall feedback"
            hint="On the whole worksheet, not one question."
          >
            <CountedTextarea
              id="review-overall"
              value={draft.overall}
              max={CIRCULATION_LIMITS.overall}
              rows={4}
              onChange={(e) => patchOverall(e.target.value)}
              onBlur={() => void saver.flush()}
            />
          </Field>
        ))}

      {!error && hydrated && !writesAnything && !config.overallFeedback && (
        <p className={styles.muted}>
          This circulation has no feedback boxes and no scoring. Answers are read, and
          nothing is written down here.
        </p>
      )}

      {returnError && (
        <p className={styles.error} role="status">
          {returnError}
        </p>
      )}

      {!error && hydrated && (config.returnToRecipient ? (
        response.state === "submitted" && (
          <div className={styles.actions}>
            <Button type="button" onClick={() => void handleReturn()} disabled={returning}>
              {returning ? "Returning…" : "Return to recipient"}
            </Button>
          </div>
        )
      ) : (
        <p className={styles.muted}>
          Feedback stays with the reviewers for this circulation.
        </p>
      ))}
    </section>
  );
}
