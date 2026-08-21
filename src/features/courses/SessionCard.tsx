"use client";

import Card from "@/components/ui/Card";
import Chip from "@/components/ui/Chip";
import type { OverviewGroup } from "@/app/api/courses/runs/[runId]/overview/route";
import { validateSubmissionUrl } from "@/lib/firestore/courses";
import { GROUP_FIELD_LIMITS } from "@/lib/firestore/courseGroups";
import {
  addDaysToKey,
  isValidDateKey,
  londonDateKey,
  londonWallClockToInstant,
} from "@/lib/courses/weekPlan";
import styles from "./SessionCard.module.css";

/**
 * The group's session for the slot being viewed — presentational, no data
 * access of its own.
 *
 * A group stores a RECURRING slot (`weekday` + `startTimeLocal`), not dates,
 * so the concrete session is derived: the slot the cohort is in starts on
 * `slotStartKey`, and the session is the first `weekday` on or after it. Both
 * ends of that arithmetic are civil-date maths (`addDaysToKey`) rather than
 * elapsed milliseconds, and only the final wall clock becomes an instant
 * (`londonWallClockToInstant`), so a clock-change week resolves to the right
 * London evening instead of drifting an hour.
 *
 * NO ICS EXPORT HERE, deliberately: `src/lib/events/` builds an ICS from an
 * event document (one dated thing with a title and a location), and a course
 * session is a slot inside a plan — the recurring rule, the per-week
 * overrides and the break weeks have no counterpart in that helper. A
 * calendar feed for a cohort is its own piece of work, not a prop on this card.
 */

type SessionState = "upcoming" | "today" | "held";

type Props = {
  group: OverviewGroup;
  /**
   * The civil date the viewed slot began (`CurrentWeek.slotStartKey`). `null`
   * on a run with no usable start date — the card then falls back to the
   * recurring label and stays stateless rather than inventing a date.
   */
  slotStartKey: string | null;
  title?: string;
};

const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Module-scoped: constructing an `Intl.DateTimeFormat` is expensive relative
 * to using one (the `weekPlan.ts` precedent), and this renders on every week
 * page. `timeZone: "UTC"` because the input is a civil date parsed at UTC
 * midnight — it is a date, not an instant, and must not be re-zoned.
 */
const SESSION_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "18:00" + 90 → "19:30". Null when the slot has no usable duration. */
function endTimeLabel(start: string, minutes: number): string | null {
  const m = WALL_CLOCK.exec(start);
  if (!m || minutes <= 0) return null;
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  return `${hh}:${String(total % 60).padStart(2, "0")}`;
}

type SessionWindow = { dateKey: string; startsAt: Date; endsAt: Date };

function sessionWindow(group: OverviewGroup, slotStartKey: string | null): SessionWindow | null {
  if (!slotStartKey || !isValidDateKey(slotStartKey)) return null;
  if (!WALL_CLOCK.test(group.startTimeLocal)) return null;
  // Date keys parse at UTC midnight, so `getUTCDay()` reads the civil weekday
  // with no zone in play — the same convention `GroupSession.weekday` uses.
  const slotWeekday = new Date(`${slotStartKey}T00:00:00Z`).getUTCDay();
  const dateKey = addDaysToKey(slotStartKey, (group.weekday - slotWeekday + 7) % 7);
  const startsAt = londonWallClockToInstant(dateKey, group.startTimeLocal);
  const endsAt = new Date(
    startsAt.getTime() + Math.max(0, group.durationMinutes) * 60_000,
  );
  return { dateKey, startsAt, endsAt };
}

/**
 * Held wins over today: a Tuesday-evening group read on Tuesday night has
 * already met, and "Today" over a session that finished two hours ago is the
 * one state that would actively mislead someone into turning up.
 */
function sessionState(occurrence: SessionWindow | null, now: Date): SessionState {
  if (!occurrence) return "upcoming";
  if (now.getTime() >= occurrence.endsAt.getTime()) return "held";
  return londonDateKey(now) === occurrence.dateKey ? "today" : "upcoming";
}

function facilitatorLine(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `with ${names[0]}`;
  return `with ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function SessionCard({
  group,
  slotStartKey,
  title = "This week's session",
}: Props) {
  const occurrence = sessionWindow(group, slotStartKey);
  const state = sessionState(occurrence, new Date());

  const end = endTimeLabel(group.startTimeLocal, group.durationMinutes);
  const timeRange = WALL_CLOCK.test(group.startTimeLocal)
    ? `${group.startTimeLocal}${end ? `–${end}` : ""}`
    : "";
  // With a resolved date the card names the actual evening; without one it
  // falls back to the run's recurring label rather than guessing.
  const when = occurrence
    ? [
        SESSION_DATE_FORMAT.format(new Date(`${occurrence.dateKey}T00:00:00Z`)),
        timeRange,
      ]
        .filter(Boolean)
        .join(" · ")
    : group.sessionLabel;

  // Meeting links are facilitator-authored. `validateSubmissionUrl` is the
  // same gate `GroupEditor` applies on save, re-applied at render so a link
  // stored before that validator existed can't put a `javascript:` URL behind
  // a button.
  const meetingUrl =
    group.meetingUrl &&
    !validateSubmissionUrl(group.meetingUrl, GROUP_FIELD_LIMITS.meetingUrl)
      ? group.meetingUrl
      : null;

  const facilitators = facilitatorLine(group.facilitatorNames);

  return (
    <Card
      as="section"
      padding="md"
      className={[styles.card, styles[state]].join(" ")}
    >
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        {state === "today" && <Chip tone="accent" size="sm">Today</Chip>}
      </div>

      <p className={styles.group}>
        {group.name}
        {facilitators && <span className={styles.facilitators}> {facilitators}</span>}
      </p>

      {when && <p className={styles.when}>{when}</p>}
      {group.location && <p className={styles.location}>{group.location}</p>}

      {state === "held" && (
        <p className={styles.note}>This week&apos;s session has happened.</p>
      )}

      {meetingUrl && (
        // <Button> renders a real <button> and takes no href, so a navigation
        // target gets the styling rather than the component (the CourseCTA call).
        <a
          className={styles.button}
          href={meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Join the call
        </a>
      )}
    </Card>
  );
}
