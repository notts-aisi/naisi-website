"use client";

import MemberText from "@/components/ui/MemberText";
import StarRating from "@/components/ui/StarRating";
import { RATING_MAX } from "@/lib/firestore/courseProgress";
import {
  answerIsEmpty,
  ratingScaleOf,
  type WorksheetAnswer,
  type WorksheetQuestion,
} from "@/lib/firestore/worksheets";
import styles from "./AnswerSummary.module.css";

/**
 * One answer, read-only, as staff see it.
 *
 * ── THE TWO THINGS THIS COMPONENT IS RESPONSIBLE FOR ────────────────────────
 * 1. TEXT GOES THROUGH `MemberText`. Everything a recipient typed is member
 *    text, and `MemberText` is the boundary the whole codebase renders it at:
 *    a React text node, never markdown, never `dangerouslySetInnerHTML`,
 *    never auto-linked. Reaching past it here would open the surface that
 *    component exists to close, on a page staff read many people's answers on.
 * 2. CHOICES RESOLVE THROUGH THE OPTION IDS. Answers store option ids, never
 *    labels, precisely so a reviewer fixing a typo mid-flight does not rewrite
 *    what anybody said. An id that no longer matches an option renders as
 *    "(option removed)" rather than disappearing: a silently dropped answer
 *    reads as "they did not answer that", which is a different and worse claim
 *    than "this option is gone".
 * ────────────────────────────────────────────────────────────────────────────
 */

type Props = {
  question: WorksheetQuestion;
  answer: WorksheetAnswer | undefined;
};

const MISSING_OPTION = "(option removed)";

function labelOf(question: WorksheetQuestion, optionId: string): string {
  const option = (question.options ?? []).find((o) => o.id === optionId);
  return option?.label.trim() || MISSING_OPTION;
}

export default function AnswerSummary({ question, answer }: Props) {
  if (!answer || answerIsEmpty(answer)) {
    return <p className={styles.empty}>No answer</p>;
  }

  switch (answer.type) {
    case "text":
      return <MemberText text={answer.text} className={styles.text} />;

    case "choice":
      return <p className={styles.choice}>{labelOf(question, answer.optionId)}</p>;

    case "choices":
      return (
        <ul className={styles.choices}>
          {answer.optionIds.map((optionId, index) => (
            // The id can repeat only on a malformed answer, which
            // `validateAnswer` refuses at submit; the index keeps React quiet
            // if one ever reaches this read path anyway.
            <li key={`${optionId}-${index}`} className={styles.choiceItem}>
              {labelOf(question, optionId)}
            </li>
          ))}
        </ul>
      );

    case "rating": {
      const scale = ratingScaleOf(question);
      return (
        // A <div> rather than a <p>: StarRating's read-only form renders a
        // <div role="img">, and a div inside a p is invalid markup that React
        // complains about on every rating answer and that hydration would
        // break. `.rating` is a flex row either way.
        <div className={styles.rating}>
          <span className={styles.ratingValue}>
            {answer.value} of {scale}
          </span>
          {/* StarRating draws a FIXED five stars (RATING_MAX, the course
              rating's scale). A worksheet's scale runs 3 to 10, so the stars
              are shown only where the two agree; every other scale reads as
              the number, which is the honest picture of it. */}
          {scale === RATING_MAX && (
            <StarRating
              value={answer.value}
              readOnly
              size="sm"
              ariaLabel={`${question.title || "Rating"}: their answer`}
            />
          )}
        </div>
      );
    }

    case "images":
      return (
        <ul className={styles.images}>
          {answer.images.map((image, index) => (
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
            </li>
          ))}
        </ul>
      );
  }
}
