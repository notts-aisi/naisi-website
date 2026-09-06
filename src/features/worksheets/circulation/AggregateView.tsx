"use client";

import { useCallback, useMemo, useState } from "react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import MemberName from "@/components/ui/MemberName";
import MemberText from "@/components/ui/MemberText";
import Skeleton from "@/components/ui/Skeleton";
import Switch from "@/components/ui/Switch";
import { useTaskRoster } from "@/features/tasks/hooks/useTaskRoster";
import type { CirculationDoc, ResponseDoc } from "@/lib/firestore/circulations";
import { questionsOf, type WorksheetQuestion } from "@/lib/firestore/worksheets";
import {
  aggregateQuestion,
  answersFor,
  UNTITLED_QUESTION_HEADER,
  type OptionTally,
  type QuestionAggregate,
} from "../aggregate";
import styles from "./AggregateView.module.css";

/**
 * EVERYBODY'S ANSWERS AT ONCE: the tab a sender opens to see what a worksheet
 * actually told them.
 *
 * ── IT COUNTS WHAT IS ON SCREEN, NOT WHAT A ROUTE SAYS ──────────────────────
 * The staff already hold every response document: the circulation page's
 * listener is a live read of the whole subcollection, allowed by one `get()`
 * of the parent. So this component is handed those documents and counts them
 * in the browser, which is why the "Submitted only" switch is instant and why
 * the numbers move as people type. `GET .../aggregate` exists for the OTHER
 * audience, a recipient reading a poll's results, who is allowed a count and
 * nothing else and cannot list the subcollection at all. Both roads run
 * through the same functions in `../aggregate`, so what a recipient sees on a
 * poll and what staff see on the same poll cannot come to disagree.
 *
 * ── IN-PROGRESS ANSWERS COUNT, AND THE HEADER SAYS SO ───────────────────────
 * The default is every stored answer, submitted or not, because a sender
 * looking at this mid-week is asking what people think and not who has
 * finished. That is a claim worth printing rather than assuming, so the header
 * prints it, and the switch beside it narrows the set to submitted and
 * reviewed responses for anybody who wants the settled picture.
 *
 * ── NAMES ARE ALLOWED HERE, AND CAN BE TURNED OFF ───────────────────────────
 * This is a staff surface: the recipient table beside it already lists who has
 * what, so hiding names on the text answers would protect nothing. They are on
 * by default because feedback without a name is hard to act on. The "Hide
 * names" switch is for the other situation, reading the answers out to a room,
 * where a name on a screen is a different thing from a name in a private tab.
 * It is a display toggle and nothing more: the data is the same either way,
 * and the export carries names regardless.
 *
 * ── NO CHART LIBRARY ────────────────────────────────────────────────────────
 * Every bar here is a `<div>` with a percentage width, drawn from tokens. A
 * chart library would be a dependency, a bundle and a second theme to keep in
 * step with `tokens.css` for what is, in the end, a rectangle.
 *
 * ── A BAR IS ITS REAL PERCENTAGE, THE SAME AS THE RECIPIENT'S ───────────────
 * Not a share of the leading bar, which would draw a livelier chart and a
 * different one: `PollResults` shows a recipient the same poll at its true
 * percentage, and one poll rendered two geometries is one poll that looks like
 * two findings depending on who is describing it. Same numbers, same shapes,
 * both surfaces.
 */

type Props = {
  circulation: CirculationDoc;
  responses: ResponseDoc[];
  /**
   * The page's own name resolver, when it has one.
   *
   * OPTIONAL, and there is a reason on both sides. The circulation page
   * already builds a better map than this component can (the task roster
   * PLUS the recipient roster, which between them cover an author or an admin
   * who shares no task with anybody here), so passing it down beats resolving
   * twice. But this component must not render a column of "NAISI member" if
   * whoever mounts it forgets, so it falls back to the task roster on its own,
   * from `AggregateWithRoster` below, which exists so that fallback fetch is
   * not made when this prop makes it pointless.
   */
  nameOf?: (uid: string) => string;
  /**
   * Is the responses listener still settling?
   *
   * Without it a tab opened on the first frame says "Nobody has this yet"
   * about a circulation with thirty recipients, and then corrects itself,
   * which is a worse thing to have read than a skeleton. Optional and
   * defaulting to false so a caller that has already settled (or has no such
   * state) mounts this unchanged.
   */
  loading?: boolean;
};

/** Submitted and reviewed both count as submitted: a reviewer working through
 *  the pile must not make the number fall. Same rule as `submittedTally`. */
function isSubmitted(response: ResponseDoc): boolean {
  return response.state === "submitted" || response.state === "reviewed";
}

/**
 * The mount point, and the ONE decision it makes: whose names to use.
 *
 * `useTaskRoster` is a fetch of `/api/members/roster`, and the circulation
 * page already holds one. Calling it unconditionally here would fire a second
 * request for a map that is thrown away the moment `nameOf` is passed, and a
 * hook cannot be called conditionally, so the fallback lives in a component of
 * its own that is only ever rendered when there is no resolver to use.
 *
 * The switch between the two is not a thing that happens: a caller either
 * passes a resolver or does not, for the life of the mount. If one ever
 * toggled the prop, React would swap component types and the two switches
 * below would reset, which is worth knowing and not worth defending against.
 */
export default function AggregateView(props: Props) {
  if (props.nameOf) return <Aggregate {...props} nameOf={props.nameOf} />;
  return <AggregateWithRoster {...props} />;
}

/** The fallback name source, for a caller that passed none. NEVER the `users`
 *  collection: staff here may be an ordinary committee member holding
 *  `circulateWorksheet` and nothing else, who cannot read it. */
function AggregateWithRoster(props: Props) {
  const { users } = useTaskRoster();

  const rosterNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of users) {
      if (member.displayName) map.set(member.uid, member.displayName);
    }
    return map;
  }, [users]);

  /** `MemberName`'s own fallback is what an empty string turns into, so a uid
   *  the roster has never heard of still reads as a person. */
  const resolveName = useCallback(
    (uid: string) => rosterNames.get(uid) ?? "",
    [rosterNames],
  );

  return <Aggregate {...props} nameOf={resolveName} />;
}

function Aggregate({
  circulation,
  responses,
  nameOf,
  loading = false,
}: Props & { nameOf: (uid: string) => string }) {
  const [submittedOnly, setSubmittedOnly] = useState(false);
  const [hideNames, setHideNames] = useState(false);

  const questions = useMemo(() => questionsOf(circulation.items), [circulation.items]);

  const counted = useMemo(
    () => (submittedOnly ? responses.filter(isSubmitted) : responses),
    [responses, submittedOnly],
  );

  const submitted = useMemo(() => responses.filter(isSubmitted).length, [responses]);

  /**
   * Every question counted once per change of the set, rather than once per
   * render. Both switches re-render this component, and so does any change on
   * the page above it (a recipient's autosave lands roughly every few
   * seconds), and re-walking every answer of every response each time is work
   * nobody asked for on a tab that is often left open.
   */
  const aggregates = useMemo(
    () =>
      questions.map((question) => ({
        question,
        aggregate: aggregateQuestion(question, answersFor(question, counted)),
      })),
    [questions, counted],
  );

  if (questions.length === 0) {
    return (
      <EmptyState
        title="There is nothing to count"
        body="This worksheet has no questions in it yet, so there are no answers to add up."
      />
    );
  }

  // The listener before the claim: "nobody has this yet" is a statement about
  // the circulation, and it must not be made about a subcollection that has
  // simply not arrived.
  if (loading && responses.length === 0) {
    return (
      <div className={styles.view}>
        <Skeleton
          width="100%"
          height="3rem"
          radius="var(--radius-md)"
          ariaLabel="Counting the answers…"
        />
        <Skeleton width="100%" height="8rem" radius="var(--radius-md)" ariaLabel="" />
      </div>
    );
  }

  if (responses.length === 0) {
    return (
      <EmptyState
        title="Nobody has this yet"
        body="Once people have it and start answering, their answers are added up here."
      />
    );
  }

  return (
    <div className={styles.view}>
      <header className={styles.bar}>
        <p className={styles.tally}>
          {submitted} of {responses.length} submitted
          {submittedOnly
            ? ". Only submitted answers are counted below."
            : ". The figures below include answers from people still working."}
        </p>
        <div className={styles.switches}>
          <Switch
            checked={submittedOnly}
            onChange={setSubmittedOnly}
            label="Submitted only"
          />
          <Switch checked={hideNames} onChange={setHideNames} label="Hide names" />
        </div>
      </header>

      <ol className={styles.questions}>
        {aggregates.map(({ question, aggregate }) => (
          <li key={question.id}>
            <Card as="section" padding="md" className={styles.card}>
              <h3 className={styles.title}>
                {question.title.trim() || UNTITLED_QUESTION_HEADER}
              </h3>
              <QuestionAggregateBody
                question={question}
                aggregate={aggregate}
                hideNames={hideNames}
                nameOf={nameOf}
              />
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

function QuestionAggregateBody({
  question,
  aggregate,
  hideNames,
  nameOf,
}: {
  question: WorksheetQuestion;
  aggregate: QuestionAggregate;
  hideNames: boolean;
  nameOf: (uid: string) => string;
}) {
  if (aggregate.respondents === 0) {
    return <p className={styles.empty}>No answers yet.</p>;
  }

  switch (aggregate.kind) {
    case "options":
      return (
        <>
          <p className={styles.count}>
            {aggregate.respondents}{" "}
            {aggregate.respondents === 1 ? "respondent" : "respondents"}
            {/* Said out loud on multiple choice only, where the percentages
                sum past 100 and a reader is owed the reason. */}
            {question.type === "multipleChoice" && ", who could pick more than one"}
          </p>
          <Bars tallies={aggregate.options} />
        </>
      );

    case "rating":
      return (
        <>
          <p className={styles.count}>
            {/* `mean` is null only over an empty set, which the empty state
                above has already caught; the branch is here so the null can
                never be printed as "NaN" if that ever stops being true. */}
            {aggregate.mean === null
              ? "No ratings yet"
              : `Mean ${aggregate.mean.toFixed(1)} of ${aggregate.scale}, from ${
                  aggregate.respondents
                } ${aggregate.respondents === 1 ? "rating" : "ratings"}`}
          </p>
          <Bars
            tallies={aggregate.bands.map((band) => ({
              optionId: String(band.value),
              label: String(band.value),
              count: band.count,
              percent: band.percent,
              removed: false,
            }))}
          />
        </>
      );

    case "text":
      return (
        <>
          <p className={styles.count}>
            {aggregate.respondents} {aggregate.respondents === 1 ? "answer" : "answers"}
          </p>
          <ul className={styles.texts}>
            {aggregate.texts.map((entry) => (
              <li key={entry.uid} className={styles.textItem}>
                {!hideNames && (
                  <p className={styles.attribution}>
                    <MemberName name={nameOf(entry.uid)} />
                  </p>
                )}
                {/* Member text, so `MemberText` and nothing else: a React text
                    node, never markdown, never HTML, never auto-linked. This
                    page puts many people's words in front of one reader, which
                    is exactly where that boundary earns its keep. */}
                <MemberText text={entry.text} className={styles.text} />
              </li>
            ))}
          </ul>
        </>
      );

    case "images":
      return (
        <>
          <p className={styles.count}>
            {aggregate.respondents} {aggregate.respondents === 1 ? "answer" : "answers"}
          </p>
          <ul className={styles.images}>
            {aggregate.rows.flatMap((row) =>
              row.images.map((image, index) => (
                <li key={image.storagePath} className={styles.imageItem}>
                  {/* Plain <img>: next/image breaks this repo's Turbopack
                      production build, so every image on the site is one of
                      these plus the eslint-disable line. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={`Uploaded image ${index + 1}`}
                    className={styles.image}
                    loading="lazy"
                  />
                  {!hideNames && (
                    <span className={styles.attribution}>
                      <MemberName name={nameOf(row.uid)} />
                    </span>
                  )}
                </li>
              )),
            )}
          </ul>
        </>
      );
  }
}

/**
 * The bars. One row per option: a label, a track, and the count with its
 * percentage.
 *
 * The width IS the percentage the text beside it names. A share of the widest
 * bar would draw a livelier chart on a question where nothing passed 20%, and
 * it would also be a second geometry for a number `PollResults` already draws
 * at its true width for the recipient. One poll, two pictures, and whichever
 * one a person saw first is the one they would describe.
 */
function Bars({ tallies }: { tallies: OptionTally[] }) {
  return (
    <ul className={styles.bars}>
      {tallies.map((tally) => (
        <li key={tally.optionId} className={styles.barRow}>
          <span className={tally.removed ? styles.barLabelGone : styles.barLabel}>
            {tally.label}
          </span>
          <span className={styles.barTrack}>
            <span
              className={styles.barFill}
              // The one inline style in the file, and it has to be: the width
              // is data. Every colour and radius on it comes from the class.
              style={{ width: `${tally.percent}%` }}
            />
          </span>
          <span className={styles.barCount}>
            {tally.count} ({tally.percent}%)
          </span>
        </li>
      ))}
    </ul>
  );
}
