"use client";

import { useMemo } from "react";
import Link from "next/link";
import Card from "@/components/ui/Card";
import type { MyRunEntry } from "@/app/api/courses/me/route";
import { useMyRuns } from "./useMyRuns";
import { SyncTasksTrigger } from "./useSyncTasks";
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

/**
 * P10 — whether this row is worth a mirror POST.
 *
 * The dashboard earns its place as the THIRD trigger point because it is the
 * only one on the path of the member the mirror exists for: someone who lives
 * on My Work and opens `/learn` rarely. If mirroring only happened inside the
 * course, the task would arrive on the board at the exact moment it stopped
 * being useful — they were already reading the week.
 *
 * It is also the trigger that has to justify its cost, because this is the
 * most-opened authed page in the app, and it is the only trigger that can fire
 * more than once per mount. Two conditions, and they are the sync-tasks
 * route's OWN conditions restated client-side so the common answer costs no
 * round trip at all (the session-scoped claim in useSyncTasks is the other
 * half of that, and covers the repeat MOUNTS this filter cannot see):
 *
 *   • an ENROLMENT on the run — `learner`/`facilitator` are the two roles that
 *     come from a `courseEnrolments` row, and they are exactly who the route
 *     serves. (Same half as the card's render filter; restated so this
 *     predicate stays correct if that filter ever loosens.) A reviewer's or
 *     track lead's row reaches this card by a different door and earns a 403.
 *   • `phase === "running"` with a started taught week — the route returns
 *     `weekNumber: null` for anything else, and it spends a session
 *     verification (an Auth RPC plus a `users` doc read) and two more doc reads
 *     to say so. Cheap per call, not free, and this card can make up to four of
 *     them.
 *
 * What survives is ~one POST for a member on one live course, which the route
 * answers from the enrolment's high-water mark with no write at all — and,
 * since the trigger's claim is module-scoped, only on the FIRST dashboard visit
 * of a cohort week rather than on every mount (see useSyncTasks).
 *
 * Two known, deliberate gaps, both covered by the other two trigger points:
 *   • enrolment STATUS is invisible here — `/api/courses/me` reports the role
 *     for an active or a `completed` enrolment alike, and the route requires
 *     `active`. A completed enrolment on a still-running run is rare, and the
 *     refusal is swallowed.
 *   • only the `MAX_ROWS` rows this card renders are considered, so a member
 *     on five live courses mirrors four from here and the fifth on the run's
 *     own page. Firing for rows the card does not show would be a hidden cost
 *     on the busiest page in the app.
 */
function shouldMirror(entry: MyRunEntry): boolean {
  const enrolled =
    entry.roles.includes("learner") || entry.roles.includes("facilitator");
  if (!enrolled) return false;
  const week = entry.currentWeek;
  return week?.phase === "running" && week.anchorWeekNumber > 0;
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
      {/* Renders nothing — one instance per run so each gets its own hook and
          its own lifecycle (see SyncTasksTrigger). Mounted below the early
          return above, so a still-loading dashboard never fires.

          The once-per-(run, anchor week) claim these share is MODULE-scoped,
          which is what makes this card affordable on the busiest page in the
          app: the four triggers cost four POSTs on the first dashboard visit
          of a cohort week and nothing on every visit after it — including
          every soft navigation back here from a course page. `shouldMirror`
          has already guaranteed a `currentWeek` with a started taught week, so
          the anchor is a real number here, never the null fallback. */}
      {live.filter(shouldMirror).map((entry) => (
        <SyncTasksTrigger
          key={entry.runId}
          runId={entry.runId}
          anchorWeek={entry.currentWeek?.anchorWeekNumber ?? null}
        />
      ))}

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
