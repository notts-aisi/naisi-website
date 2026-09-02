import type { CoursePageJourneyStep } from "@/lib/firestore/coursePages";
import { journeyStepStates } from "@/lib/courses/journeyStep";
import styles from "./JourneyStrip.module.css";

/**
 * "How this term goes": applications open, applications close, decisions,
 * first session, last session, with the step the reader is standing in marked.
 *
 * ## The current step is derived from a DATE KEY, not from a clock
 *
 * The caller passes today's Europe/London date key
 * (`londonDateKey(new Date())`) and `journeyStepStates` compares strings. The
 * alternative, comparing instants in the browser, is wrong for eight hours of
 * every London day: a visitor in Los Angeles would be told applications close
 * tomorrow on the morning they close. See `lib/courses/journeyStep.ts`.
 *
 * A step with no date never becomes "current". It still renders, because "we
 * run six sessions" is a real step of the journey with no day attached, and
 * dropping it would leave a strip that skips from decisions to the end.
 *
 * ## `aria-current`, and why the marker is not colour alone
 *
 * The current step carries `aria-current="step"` and a visible "You are here"
 * label. A coloured dot alone says nothing to a screen reader and nothing to a
 * reader who cannot separate the two accents.
 */

type Props = {
  steps: CoursePageJourneyStep[];
  /** Today in Europe/London, as "YYYY-MM-DD". Resolved by the server page. */
  todayKey: string;
  /** Pre-formatted per step, in London, by the server. Empty string for none. */
  dateLabels: string[];
};

export default function JourneyStrip({ steps, todayKey, dateLabels }: Props) {
  if (steps.length === 0) return null;
  const states = journeyStepStates(steps, todayKey);

  return (
    <section className={styles.section} aria-labelledby="journey-heading">
      <h2 id="journey-heading" className={styles.heading}>
        How this term goes
      </h2>
      <ol className={styles.strip}>
        {steps.map((step, i) => {
          const state = states[i];
          return (
            <li
              key={`${step.label}-${i}`}
              className={`${styles.step} ${styles[state]}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className={styles.marker} aria-hidden="true" />
              <span className={styles.label}>{step.label}</span>
              {dateLabels[i] ? (
                <span className={styles.date}>{dateLabels[i]}</span>
              ) : null}
              {step.detail ? <span className={styles.detail}>{step.detail}</span> : null}
              {state === "current" ? (
                <span className={styles.here}>You are here</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
