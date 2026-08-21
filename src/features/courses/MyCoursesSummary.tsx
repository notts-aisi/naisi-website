"use client";

import { useMemo } from "react";
import Link from "next/link";
import Card from "@/components/ui/Card";
import type { MyRunEntry } from "@/app/api/courses/me/route";
import { useMyRuns } from "./useMyRuns";
import styles from "./MyCoursesSummary.module.css";

/**
 * The courses line on the dashboard, above My Work. Self-fetching, and
 * renders NOTHING until it has something worth saying — MyWorkSummary's
 * shape: a member with no live course sees no empty card, because a
 * dashboard full of "you have none of these" is worse than a short one.
 *
 * "Live" is narrower than the hub's list on purpose. The hub answers "every
 * run I touch, ever"; the dashboard answers "what is running now":
 *
 *   • roles — learner or facilitator only. An admissions reviewer's run is a
 *     queue, not a course they are on, and it has no week to report.
 *   • status — no `completed` (history belongs on the hub), no `cancelled`,
 *     no `draft`.
 *
 * A member whose only runs are finished therefore gets no card, which is the
 * intended answer, not a bug to fix by loosening the filter.
 */

/** Rows past this are one scroll too many on a summary card; the hub has all. */
const MAX_ROWS = 4;

/**
 * The one-line version of RunCard's `statusLine`. Deliberately smaller: no
 * start date (the `/api/courses/me` row doesn't carry one) and no cancelled
 * branch (filtered out above), so this can stay a single readable chain.
 * RunCard owns the full version — change them together if the vocabulary
 * moves.
 */
function weekLine(entry: MyRunEntry): string {
  const week = entry.currentWeek;
  if (!week || week.phase === "before") return "Starts soon";
  if (week.phase === "after") return "Finished";
  // A break slot has no week number — it names itself ("Reading week") and
  // anchors to the week before it.
  if (week.breakLabel) return week.breakLabel;
  const number = week.weekNumber ?? week.anchorWeekNumber;
  if (number < 1) return "Starting this week";
  return entry.totalWeeks > 0
    ? `Week ${number} of ${entry.totalWeeks}`
    : `Week ${number}`;
}

export default function MyCoursesSummary() {
  const { runs, loading, error } = useMyRuns();

  const live = useMemo(
    () =>
      runs
        .filter(
          (entry) =>
            (entry.roles.includes("learner") || entry.roles.includes("facilitator")) &&
            entry.status !== "completed" &&
            entry.status !== "cancelled" &&
            entry.status !== "draft",
        )
        .slice(0, MAX_ROWS),
    [runs],
  );

  // Nothing to say, or nothing said yet. No skeleton either: this card sits
  // above My Work, and a placeholder that resolves to nothing would push the
  // rest of the dashboard down and then yank it back.
  if (loading || error || live.length === 0) return null;

  return (
    <Card padding="md" className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>Your courses</h3>
        <Link href="/learn" className={styles.viewAll}>
          View all →
        </Link>
      </div>

      <ul className={styles.list}>
        {live.map((entry) => (
          <li key={entry.runId}>
            <Link
              href={`/learn/${encodeURIComponent(entry.runId)}`}
              className={styles.row}
            >
              <span className={styles.name}>{entry.courseTitle}</span>
              <span className={styles.week}>{weekLine(entry)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
