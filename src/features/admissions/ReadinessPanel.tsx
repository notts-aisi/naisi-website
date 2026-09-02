"use client";

import {
  READINESS_KIND_NOTE,
  roundReadiness,
  type ReadinessInput,
} from "@/lib/admissions/readiness";
import styles from "./ReadinessPanel.module.css";

/**
 * What is still missing before this round can open, one line per blocker, each
 * with a link to the section that fixes it.
 *
 * The list comes from `roundReadiness`, which is the SAME predicate the status
 * route refuses on. That is the whole design: a panel with its own opinion
 * would eventually show a green tick beside a button that answers 409, and the
 * author would have no way to tell which of the two was lying.
 *
 * Met checks are shown too, greyed, rather than disappearing. A panel that
 * empties as you go gives no sense of what the bar actually is, and the first
 * time somebody authors a round they want to read the whole list.
 *
 * The kind note under the heading is there for the same reason. An appointment
 * round is held to five checks and an enrolment round to six, and a list that
 * is quietly one line shorter reads as a bug rather than as a decision.
 */
export default function ReadinessPanel({
  round,
  now,
}: {
  round: ReadinessInput;
  /** Injected so a test can pin the deadline-in-the-past case. */
  now?: Date;
}) {
  const readiness = roundReadiness(round, now ?? new Date());

  return (
    <section className={styles.panel} aria-labelledby="readiness-title">
      <div className={styles.head}>
        <h2 id="readiness-title" className={styles.title}>
          Ready to open?
        </h2>
        <p
          className={`${styles.verdict} ${readiness.ready ? styles.verdictReady : ""}`}
        >
          {readiness.ready
            ? "Everything this round needs is in place."
            : `${readiness.unmet.length} thing${readiness.unmet.length === 1 ? "" : "s"} still to do.`}
        </p>
        <p className={styles.kindNote}>{READINESS_KIND_NOTE[round.kind]}</p>
      </div>

      <ul className={styles.list}>
        {readiness.checks.map((check) => (
          <li key={check.id} className={styles.item}>
            <span
              className={`${styles.mark} ${check.ok ? styles.markOk : styles.markMissing}`}
              aria-hidden="true"
            >
              {check.ok ? "✓" : "•"}
            </span>
            <span>
              <span className={`${styles.label} ${check.ok ? styles.labelDone : ""}`}>
                {check.label}
                <span className="visually-hidden">{check.ok ? " (done)" : " (still to do)"}</span>
              </span>
              {!check.ok && (
                <>
                  <span className={styles.hint}>{check.hint}</span>
                  <a className={styles.jump} href={`#${check.section}`}>
                    Go to that section
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
