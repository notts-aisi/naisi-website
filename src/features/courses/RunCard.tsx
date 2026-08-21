"use client";

import Link from "next/link";
import Card from "@/components/ui/Card";
import Chip from "@/components/ui/Chip";
import ProgressRing from "@/components/ui/ProgressRing";
import type { MyRunEntry } from "@/app/api/courses/me/route";
import { COURSE_RUN_STATUS_LABEL } from "@/lib/firestore/courses";
import styles from "./RunCard.module.css";

/**
 * One run on the `/learn` hub. Presentational — everything it renders comes
 * from the `/api/courses/me` row, including the current week, which the server
 * recomputes per request from `(run, now)` rather than storing.
 *
 * Plain `next/link`, never `TransitionLink`: that component's ~960ms exit
 * choreography belongs to the public site's page transitions and would read as
 * a hang on a hub whose whole job is getting out of the way.
 */

type RunRole = MyRunEntry["roles"][number];

const ROLE_META: Record<
  RunRole,
  { label: string; tone: "accent" | "success" | "warning" | "neutral" }
> = {
  learner: { label: "Learner", tone: "accent" },
  facilitator: { label: "Facilitator", tone: "success" },
  reviewer: { label: "Reviewer", tone: "warning" },
  // Neutral, not danger: `danger` means something has gone wrong, and none of
  // these are that. A role is a fact about the member, never an alarm.
  lead: { label: "Track lead", tone: "neutral" },
};

/** Roles in a fixed order so a member's chips don't reshuffle between loads. */
const ROLE_ORDER: RunRole[] = ["learner", "facilitator", "reviewer", "lead"];

/**
 * `timeZone: "UTC"` because a run's `startDate` is a civil date parsed at UTC
 * midnight — a date, not an instant, and re-zoning it can only move it.
 */
const START_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
});

type Props = {
  /**
   * `startDate` is OPTIONAL and additive: the pinned `/api/courses/me` payload
   * doesn't carry it today, so the pre-start line degrades to "Starts soon"
   * rather than inventing a date. Nothing needs changing here when the route
   * starts sending it.
   */
  entry: MyRunEntry & { startDate?: string };
};

/**
 * The one line that answers "where am I on this?".
 *
 * A cancelled run short-circuits everything: a cohort that was called off must
 * never be described as being on week 3, however healthy its week plan still
 * looks.
 */
function statusLine(entry: Props["entry"]): string {
  if (entry.status === "cancelled") return "Cancelled";

  const week = entry.currentWeek;
  if (!week) return COURSE_RUN_STATUS_LABEL[entry.status];

  if (week.phase === "before") {
    if (!entry.startDate) return "Starts soon";
    const parsed = new Date(`${entry.startDate}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? "Starts soon"
      : `Starts ${START_DATE_FORMAT.format(parsed)}`;
  }

  if (week.phase === "after") return "Completed";

  // Running. A break slot has no week number — it names itself ("Reading
  // week") and anchors to the week before it, which is why the fallback uses
  // the anchor rather than zero.
  if (week.breakLabel) return week.breakLabel;
  const number = week.weekNumber ?? week.anchorWeekNumber;
  if (number < 1) return "Starting this week";
  return entry.totalWeeks > 0
    ? `Week ${number} of ${entry.totalWeeks}`
    : `Week ${number}`;
}

export default function RunCard({ entry }: Props) {
  const roles = ROLE_ORDER.filter((role) => entry.roles.includes(role));
  const meta = [entry.label, entry.academicYear].filter(Boolean).join(" · ");

  /**
   * The ring shows the COHORT's progress through the run — the week everyone
   * is on, out of the weeks there are. That is the only completion figure the
   * hub payload carries honestly; per-item completion lives in `courseProgress`
   * and reaching for it here would be a query per card for a number this
   * surface has never claimed to show.
   *
   * A break slot anchors to the last taught week, so the ring holds its
   * position rather than emptying while the cohort reads.
   */
  const week = entry.currentWeek;
  const ringWeek =
    entry.status !== "cancelled" && week?.phase === "running" && entry.totalWeeks > 0
      ? week.anchorWeekNumber
      : 0;

  return (
    <Link
      href={`/learn/${encodeURIComponent(entry.runId)}`}
      className={styles.link}
    >
      <Card as="article" padding="md" interactive className={styles.card}>
        <h3 className={styles.title}>{entry.courseTitle}</h3>
        {meta && <p className={styles.meta}>{meta}</p>}

        {roles.length > 0 && (
          <div className={styles.chips}>
            {roles.map((role) => (
              <Chip key={role} tone={ROLE_META[role].tone} size="sm">
                {ROLE_META[role].label}
              </Chip>
            ))}
          </div>
        )}

        <div className={styles.statusRow}>
          {ringWeek >= 1 && (
            <ProgressRing
              value={ringWeek}
              max={entry.totalWeeks}
              size={24}
              // Normally silent: the line beside it already reads "Week 3 of
              // 8", and naming the same numbers twice is noise. A break slot
              // is the exception — the line names the break instead, so the
              // ring becomes the only place those numbers appear.
              ariaLabel={
                week?.breakLabel ? `Week ${ringWeek} of ${entry.totalWeeks}` : undefined
              }
            />
          )}
          <p className={styles.status}>{statusLine(entry)}</p>
        </div>
        {entry.groupName && <p className={styles.group}>{entry.groupName}</p>}
      </Card>
    </Link>
  );
}
