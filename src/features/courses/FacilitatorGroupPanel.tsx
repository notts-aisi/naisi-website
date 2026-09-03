"use client";

import Link from "next/link";
import Card from "@/components/ui/Card";
import InitialsChip from "@/components/ui/InitialsChip";
import MemberName from "@/components/ui/MemberName";
import Skeleton from "@/components/ui/Skeleton";
import { weekHref } from "./links";
import { useGroupRoster } from "./useGroupRoster";
import type { OverviewGroup } from "@/app/api/courses/runs/[runId]/overview/route";
import styles from "./FacilitatorGroupPanel.module.css";

/**
 * ONE FACILITATED GROUP'S CARD: when it meets, who is in it, and the tools for
 * running it (the roster, the register, the review queue, its own email lane).
 *
 * ── WHY IT IS ITS OWN COMPONENT ─────────────────────────────────────────────
 * Each card needs its own roster fetch, and a hook cannot be called in a loop.
 * The run home used to draw at most one of these, so the hook sat at the top
 * of the page, and a facilitator holding two groups got nothing at all.
 *
 * ── WHY IT NOW DRAWS A SCHEDULE ─────────────────────────────────────────────
 * Holding two groups is ordinary here, and two groups can be paced apart: one
 * on the run's clock, one three weeks behind. The page's hero can only name
 * one week, and for a facilitator with no placement of their own it names the
 * RUN's, which is nobody's. So each card carries its own group's week, its own
 * date range and its own next session, resolved server-side through
 * `resolveGroupCalendar` and travelling on `OverviewGroup.calendar`.
 *
 * That is the difference the card exists to show. Two cards, two week numbers,
 * two date ranges, and a line saying so on whichever group has left the run's
 * schedule.
 *
 * The cohort-wide links (announcements, the weekly nudge) are passed in rather
 * than derived here, and only the first card is asked to draw them: they
 * address the RUN, and repeating them under every group would read as three
 * separate lanes.
 */

type Props = {
  runId: string;
  group: OverviewGroup;
  /**
   * Week numbers that are actually authored and published on this run. The
   * card picks its OWN group's week out of this list rather than being handed
   * a week: a facilitator holding two groups a fortnight apart would otherwise
   * get the same "Open week 5 materials" link on both cards, one of which is
   * three weeks ahead of the room it sits under.
   */
  publishedWeekNumbers: readonly number[];
  showCohortLinks: boolean;
};

/**
 * Module scoped: constructing an `Intl.DateTimeFormat` is expensive relative
 * to using one (the `weekPlan.ts` precedent). `timeZone: "UTC"` because these
 * are civil dates parsed at UTC midnight, dates rather than instants, and
 * re-zoning one can only move it.
 */
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
});

const WEEKDAY_DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

function formatDateKey(dateKey: string, format: Intl.DateTimeFormat): string | null {
  if (!dateKey) return null;
  const parsed = new Date(`${dateKey}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : format.format(parsed);
}

/**
 * The card's headline for this group's position: a week counter while it is
 * running, the break's own name during one, and an honest sentence at either
 * end of term. Null when the group has no usable calendar at all, on which the
 * card falls back to saying nothing rather than inventing a week.
 */
function weekLine(calendar: OverviewGroup["calendar"]): string | null {
  const current = calendar.currentWeek;
  if (!current) return null;

  if (current.phase === "before") {
    const when = formatDateKey(calendar.firstSessionDate, DAY_MONTH);
    return when ? `First session ${when}` : "Not started yet";
  }
  if (current.phase === "after") return "This group has finished";
  if (current.breakLabel) return current.breakLabel;

  const number = current.weekNumber ?? current.anchorWeekNumber;
  if (number < 1) return null;
  return calendar.totalWeeks > 0
    ? `Week ${number} of ${calendar.totalWeeks}`
    : `Week ${number}`;
}

/** "26 October to 6 December", or null when the group has no dated sessions. */
function rangeLine(calendar: OverviewGroup["calendar"]): string | null {
  const first = formatDateKey(calendar.firstSessionDate, DAY_MONTH);
  const last = formatDateKey(calendar.lastSessionDate, DAY_MONTH);
  if (!first || !last) return null;
  return first === last ? first : `${first} to ${last}`;
}

/**
 * The week THIS group's materials link should open: the week it is on, the
 * week it will return to during a break, week 1 before it starts. Null when
 * the group has no calendar, or when that week has not been published.
 */
function materialsWeek(
  calendar: OverviewGroup["calendar"],
  published: readonly number[],
): number | null {
  const current = calendar.currentWeek;
  if (!current) return null;
  const number =
    current.phase === "before"
      ? 1
      : (current.weekNumber ??
        (current.anchorWeekNumber > 0 ? current.anchorWeekNumber : 0));
  if (number < 1) return null;
  return published.includes(number) ? number : null;
}

/** "Next: Tuesday 3 November, 18:00". Null once the term is over. */
function nextLine(calendar: OverviewGroup["calendar"]): string | null {
  const next = calendar.nextSession;
  if (!next) return null;
  const when = formatDateKey(next.dateKey, WEEKDAY_DAY_MONTH);
  if (!when) return null;
  return next.startTimeLocal ? `Next: ${when}, ${next.startTimeLocal}` : `Next: ${when}`;
}

export default function FacilitatorGroupPanel({
  runId,
  group,
  publishedWeekNumbers,
  showCohortLinks,
}: Props) {
  /*
    The shared hook, the same one the facilitator group page and the email
    composer read from. It carries a manual refresh and a null-vs-zero member
    count that this page uses neither of; what it removes is the second copy of
    the fetch, the stale-response guard and the error copy.
  */
  const roster = useGroupRoster(group.id);
  const groupHref = `/learn/${encodeURIComponent(runId)}/group/${encodeURIComponent(group.id)}`;

  const week = weekLine(group.calendar);
  const range = rangeLine(group.calendar);
  const next = nextLine(group.calendar);
  const showSchedule = Boolean(week || range || next);
  const targetWeekNumber = materialsWeek(group.calendar, publishedWeekNumbers);

  return (
    <Card as="section" padding="md" className={styles.panel}>
      <h3 className={styles.panelTitle}>You facilitate {group.name}</h3>

      {/* THIS group's calendar, never the run's. See the header. */}
      {showSchedule && (
        <div className={styles.schedule}>
          {week && <p className={styles.scheduleWeek}>{week}</p>}
          {range && <p className={styles.scheduleLine}>{range}</p>}
          {next && <p className={styles.scheduleLine}>{next}</p>}
          {group.calendar.source === "group" && (
            <p className={styles.scheduleOwnPace}>
              This group runs on its own schedule, not the cohort&apos;s.
            </p>
          )}
        </div>
      )}

      {roster.loading && (
        <Skeleton lines={2} height="1.25rem" ariaLabel="Loading the roster…" />
      )}
      {roster.error && <p className={styles.panelNote}>{roster.error.message}</p>}
      {roster.group &&
        (roster.members.length === 0 ? (
          <p className={styles.panelNote}>No one is placed in this group yet.</p>
        ) : (
          /* Names only, because the roster route sends nothing else, and this is a
             cohort surface. InitialsChip is decorative and aria-hidden, so the
             name always renders beside it. */
          <ul className={styles.roster}>
            {roster.members.map((member) => (
              <li key={member.uid} className={styles.rosterItem}>
                <InitialsChip name={member.displayName} uid={member.uid} size="sm" />
                <span>
                  <MemberName name={member.displayName} />
                </span>
              </li>
            ))}
          </ul>
        ))}

      {/* Unconditional, unlike the materials link below: the review queue is
          where a facilitator's own work is, and it stays reachable even in a
          week nobody has published yet. */}
      <Link className={styles.panelLink} href={`${groupHref}/review`}>
        Review exercises
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      </Link>

      {/* Unconditional for the same reason as the review link above: the
          register and the roster are a facilitator's own tools, and they stay
          reachable in a week nobody has published yet. */}
      <Link className={styles.panelLink} href={groupHref}>
        Roster and attendance
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      </Link>

      <Link className={styles.panelLink} href={`${groupHref}/email`}>
        Email the group
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      </Link>

      {/* Only for someone who staffs the RUN (see the `canEmailCohort` prop
          on RunHome). A group facilitator has the link above and not this one:
          their room is theirs, the cohort is not. */}
      {showCohortLinks && (
        <Link
          className={styles.panelLink}
          href={`/learn/${encodeURIComponent(runId)}/email`}
        >
          Email the whole cohort
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </Link>
      )}

      {/* Same gate as the cohort link above, and for the same reason: the
          nudge addresses the whole run. Nothing sends it on a schedule, since
          this app has no scheduler, so the link has to exist for it to go out
          at all. */}
      {showCohortLinks && (
        <Link
          className={styles.panelLink}
          href={`/learn/${encodeURIComponent(runId)}/nudge`}
        >
          Send this week&apos;s nudge
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </Link>
      )}

      {targetWeekNumber !== null && (
        <Link
          className={styles.panelLink}
          href={weekHref(runId, targetWeekNumber)}
        >
          Open week {targetWeekNumber} materials
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        </Link>
      )}
    </Card>
  );
}
