"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "@/auth/AuthProvider";
import { isTerminalResponseState } from "@/lib/firestore/circulations";
import type { WorksheetQuestion } from "@/lib/firestore/worksheets";
import { tallyOptions, type OptionCounts, type OptionTally } from "../aggregate";
import { useResponse } from "../hooks/useResponse";
import styles from "./PollResults.module.css";

/**
 * WHAT EVERYBODY ELSE PICKED, for the person answering a poll.
 *
 * ── THE ONE PLACE A RECIPIENT SEES PAST THEIR OWN ANSWER ────────────────────
 * Everywhere else in this feature a recipient is sealed off from the others by
 * the shape of the rules: they may get their own response document by id and
 * may not list the subcollection at all. A poll opens that a crack, on
 * purpose, and only as far as counts. This component therefore does NOT read
 * Firestore for the numbers: it asks
 * `GET /api/worksheets/circulations/{id}/aggregate?questionId=`, which
 * re-checks the poll's `resultsVisibility` against this caller's own state
 * server-side and answers with a map from option id to a number. No names, no
 * uids, no timestamps. A client that tried to count these itself would be a
 * client asking for everybody's answers, and the rules would refuse it.
 *
 * ── WHY THE CIRCULATION ID COMES FROM THE ROUTE ─────────────────────────────
 * `WorksheetQuestionField` renders one CONTROL and takes one question; it has
 * no circulation id and should not grow one, because six of its seven branches
 * would then carry a prop only the seventh uses. This component is mounted
 * only from the poll branch of that switch, which is reached only from the
 * respond page, which is `/worksheets/respond/[circulationId]`. So the id is
 * read from the route, the way that page's own route file reads it.
 *
 * ── VOTE FIRST, THEN SEE ────────────────────────────────────────────────────
 * A "before-submit" poll shows its results as soon as this person has ANSWERED
 * it, not as soon as they arrive. The bars are an opinion the room already
 * holds, and putting them in front of somebody who has not picked yet is
 * priming the vote they came to cast. The route enforces the same rule (its
 * `before-submit` arm asks for a stored, non-empty answer), so the sentence
 * this component prints and the refusal the server would give are one
 * decision, not two that can drift. "After-submit" waits for the whole
 * response to be submitted, which is what freezes the field above.
 *
 * That is also why the panel waits for the STORED answer rather than the one
 * the page is holding: a fetch fired on the click, before the autosave has
 * landed, is a request the route would refuse, and the recipient would read
 * "the results could not be loaded" as a fault of their own answer. So the
 * click moves the highlight, "Counting the answers…" holds the space, and the
 * bars arrive with their own vote already in them.
 *
 * ── THE BAR WIDTH IS THE REAL PERCENTAGE ────────────────────────────────────
 * Not a share of the leading bar. `AggregateView` draws the same poll for
 * staff the same way, deliberately: two people looking at one poll from two
 * surfaces must not be looking at two different pictures of it.
 *
 * ── REFETCHING WHEN THE RECIPIENT'S OWN VOTE LANDS, EXACTLY ─────────────────
 * The counts are read SERVER-SIDE, so a refetch fired the moment somebody
 * clicks an option would come back without their own vote in it and read as
 * "my vote did not register". The trigger is therefore the STORED answer
 * changing, watched through the response document this page is already
 * listening to.
 *
 * The subtlety that makes it exact: the autosave writes `updatedAt` as a
 * server timestamp, and Firestore's local snapshot resolves a PENDING server
 * timestamp to null (the SDK's default `serverTimestamps: "none"`). So
 * `response.updatedAt === null` means "this write has not been acknowledged
 * yet" and a Date means it has. Waiting for the Date is waiting for the server
 * to hold the answer this component is about to ask the server to count.
 *
 * The second half of the guard is the ref: `updatedAt` also moves when the
 * activity sampler writes, every thirty seconds somebody is on the page, and
 * refetching a poll on a timer nobody asked for is a request per half minute
 * per poll. So a fetch happens only when the stored answer for THIS question
 * differs from the one the last fetch covered.
 */

type Props = {
  question: WorksheetQuestion;
  /** The option this recipient has picked, as the page holds it right now. */
  chosenOptionId: string;
  /**
   * May they see the results yet?
   *
   * False in two cases, and the copy below tells them apart: a `before-submit`
   * poll they have not answered, and an `after-submit` poll they have not
   * submitted. The caller decides it because the caller holds the live answer
   * and the frozen flag; this component holds the sentence for each.
   */
  revealed: boolean;
};

type Body = { total?: unknown; counts?: unknown };

function readCounts(raw: unknown): OptionCounts {
  if (!raw || typeof raw !== "object") return {};
  const out: OptionCounts = {};
  for (const [optionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[optionId] = value;
  }
  return out;
}

export default function PollResults({ question, chosenOptionId, revealed }: Props) {
  const params = useParams<{ circulationId: string }>();
  const circulationId =
    typeof params?.circulationId === "string" ? params.circulationId : null;
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const { response } = useResponse(circulationId, uid);
  const storedAnswer = response?.answers[question.id];
  const storedOptionId = storedAnswer?.type === "choice" ? storedAnswer.optionId : "";
  const settled = response?.updatedAt !== null && response?.updatedAt !== undefined;

  /**
   * A `before-submit` poll counts only once this person's own answer is IN the
   * document. Asking earlier is asking the route to refuse (see its
   * `before-submit` arm), and a refusal renders as an error about the results
   * when nothing has gone wrong: the autosave is simply still in the air. A
   * frozen response is the exception the route makes too, for somebody who
   * submitted without answering an optional poll.
   */
  const frozen = response ? isTerminalResponseState(response.state) : false;
  const waitingForOwnVote =
    question.poll?.resultsVisibility === "before-submit" && !storedOptionId && !frozen;

  const [tallies, setTallies] = useState<OptionTally[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);

  /** The stored answer the counts on screen were fetched for. `null` before
   *  the first fetch, so the first render always asks. */
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!revealed || !circulationId) return;
    // Nothing has been acknowledged yet, so a fetch now would count a document
    // the server has not seen. The listener fires again when it has.
    if (!settled) return;
    // Their own vote is still in the debouncer. The listener fires when it
    // lands, and this runs again with something the route will count.
    if (waitingForOwnVote) return;
    if (fetchedFor.current === storedOptionId) return;
    fetchedFor.current = storedOptionId;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/worksheets/circulations/${encodeURIComponent(circulationId)}/aggregate` +
            `?questionId=${encodeURIComponent(question.id)}`,
        );
        if (!res.ok) throw new Error(`Results unavailable (${res.status})`);
        const body = (await res.json()) as Body;
        if (cancelled) return;
        const counts = readCounts(body.counts);
        const respondents =
          typeof body.total === "number" && Number.isFinite(body.total) ? body.total : 0;
        setTotal(respondents);
        setTallies(tallyOptions(question, counts, respondents));
        setFailed(false);
      } catch {
        if (cancelled) return;
        // The next change re-asks. A failed count is worth one quiet line and
        // nothing more: it is not the recipient's work that is at risk, and an
        // alarming message about a bar chart would drown the autosave errors
        // on this page that DO matter.
        fetchedFor.current = null;
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [circulationId, question, revealed, settled, storedOptionId, waitingForOwnVote]);

  // Rendered somewhere with no circulation in the URL, which today means
  // nowhere: this is mounted only from the respond page. Nothing rather than a
  // spinner that never resolves, so a future preview of a worksheet outside
  // that route degrades to a poll with no results instead of a broken one.
  if (!circulationId) return null;

  if (!revealed) {
    // Two different waits, and a member reading the wrong sentence would sit
    // there having answered, waiting for a submission the poll never wanted.
    return (
      <p className={styles.pending}>
        {question.poll?.resultsVisibility === "before-submit"
          ? "Results appear once you answer."
          : "Results appear after you submit."}
      </p>
    );
  }

  if (failed && tallies === null) {
    return <p className={styles.pending}>The results could not be loaded just now.</p>;
  }

  if (tallies === null) {
    return <p className={styles.pending}>Counting the answers…</p>;
  }

  if (total === 0) {
    return <p className={styles.pending}>Nobody has answered this yet.</p>;
  }

  return (
    <div className={styles.results}>
      <p className={styles.total}>
        {total} {total === 1 ? "answer" : "answers"} so far
      </p>
      <ul className={styles.bars}>
        {tallies.map((tally) => {
          // The recipient's own pick, highlighted from the LIVE value rather
          // than the stored one: the moment they click, the highlight moves,
          // even though the counts behind it wait for the write to land.
          const mine = tally.optionId === chosenOptionId;
          return (
            <li key={tally.optionId} className={styles.row}>
              <span className={mine ? styles.labelMine : styles.label}>
                {tally.label}
                {mine && <span className={styles.yours}> your answer</span>}
              </span>
              <span className={styles.track}>
                <span
                  className={mine ? styles.fillMine : styles.fill}
                  // The one inline style here, and it has to be: the width is
                  // the data. The colours are in the classes, which is also
                  // what stops Safari painting its own face over them.
                  style={{ width: `${tally.percent}%` }}
                />
              </span>
              <span className={styles.count}>
                {tally.count} ({tally.percent}%)
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
