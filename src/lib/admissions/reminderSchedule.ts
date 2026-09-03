import {
  addDaysToKey,
  londonDateKey,
  londonWallClockToInstant,
} from "@/lib/courses/weekPlan";
import { isStaleWork } from "@/lib/firestore/schedulerMarkers";

/**
 * WHEN a round's deadline reminders are due, worked out from the round's own
 * `closesAt` at TICK TIME.
 *
 * ## Nothing is scheduled, so nothing has to be rescheduled
 *
 * There is no stored due list. Each tick reads `closesAt` and the round's
 * `reminderOffsets` and derives the instants again from scratch, which is
 * what makes moving a deadline free: an admin who pushes the close date back
 * a week moves every reminder with it, and an admin who brings it forward
 * moves them forward, without a single stored row changing. The only thing
 * that remembers anything is the marker, and it remembers the RESOLVED DATE
 * rather than the offset (see `markerDateKey` below).
 *
 * ## The marker keys on the resolved civil date, not on the offset id
 *
 * `remind__{roundId}__{uid}__{dueAtKey}` where `dueAtKey` is the London civil
 * date the reminder resolved to. Two consequences, both deliberate:
 *
 *  1. Editing the schedule cannot re-send. If `t7` has gone out for 27 Sep
 *     and somebody then edits it to 6 days before, the new instant resolves
 *     to 28 Sep and is a genuinely different send. Keying on `t7` would have
 *     let an edit to the SAME resolved day re-mail everybody, which is the
 *     failure people notice.
 *  2. Two offsets that resolve to the same day are ONE send. A round closing
 *     on a Sunday with offsets at 3 days and at 0 days on a three-day window
 *     can collapse; the applicant gets one email that day rather than two,
 *     because the second offset's claim finds the first offset's marker.
 *
 * ## A reminder never resolves past the deadline it is counting down to
 *
 * An offset carries its own wall clock, so a deadline-day offset at 12:00 on
 * a round that closes at 09:00 resolves to three hours AFTER the form stopped
 * accepting anybody. That entry is dropped rather than sent: the email would
 * read "applications close today at 09:00" and link to a form that refuses
 * the reader. The job additionally gates the whole round on `isRoundOpen`
 * (`src/lib/admissions/window.ts`), so the two halves agree.
 *
 * ## Europe/London, via the module the rest of the platform already uses
 *
 * `londonWallClockToInstant` is the fiddly one and it is already written,
 * tested and used by the week plan. 10:00 on 27 Sep 2026 is BST and 10:00 on
 * 27 Nov is GMT; deriving either by subtracting hours from a UTC instant gets
 * one of them wrong for half the year.
 */

/** The shape this module needs off a round's `reminderOffsets` entry. */
export type ReminderOffsetLike = {
  id: string;
  /** Days before the round's `closesAt`. 0 is deadline day. */
  daysBefore: number;
  /** London wall clock on that day, 24-hour "HH:MM". */
  atLocalTime: string;
};

/**
 * The wall clock used when an offset carries none.
 *
 * `admissionRounds` DOES have a local-time field (`ReminderOffset.atLocalTime`,
 * validated to `HH:MM` by its normaliser), so this is a floor rather than a
 * design decision: a document written by an older build, or by hand in the
 * console, can still reach the tick with a blank. 09:00 rather than midnight
 * because a reminder is a nudge to a person, and a nudge that lands at 00:00
 * is read at 08:00 anyway with a night of unread mail on top of it.
 */
export const DEFAULT_REMINDER_TIME_LOCAL = "09:00";

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type ReminderDueState =
  /** Its instant is still ahead. Nothing to do this tick. */
  | "pending"
  /** Due, and inside the job's `maxLateHours`. Send it. */
  | "due"
  /** Due, and too long ago to be worth sending. Stamp it, do not mail it. */
  | "stale";

export type ReminderDue = {
  /**
   * The London civil date this reminder resolved to, and the marker's
   * `dueAtKey` component verbatim.
   */
  dueAtKey: string;
  /** The instant the reminder becomes due. */
  dueAt: Date;
  /**
   * Every offset that resolved to this date, in the order the round lists
   * them. More than one means they collapsed onto one send.
   */
  offsetIds: string[];
  state: ReminderDueState;
};

/** The civil date `daysBefore` days before the round's close, in London. */
export function markerDateKey(closesAt: Date, daysBefore: number): string {
  return addDaysToKey(londonDateKey(closesAt), -Math.max(0, Math.floor(daysBefore)));
}

/**
 * The instant one offset resolves to: `closesAt` moved back `daysBefore`
 * CIVIL days in London, then set to the offset's local wall clock.
 *
 * Civil days rather than 24-hour blocks: a clock change inside the window
 * would otherwise drift the reminder by an hour and, on a reminder timed for
 * midnight, by a day.
 */
export function reminderDueAt(
  closesAt: Date,
  offset: ReminderOffsetLike,
): { dueAtKey: string; dueAt: Date } {
  const dueAtKey = markerDateKey(closesAt, offset.daysBefore);
  const at = WALL_CLOCK.test(offset.atLocalTime)
    ? offset.atLocalTime
    : DEFAULT_REMINDER_TIME_LOCAL;
  return { dueAtKey, dueAt: londonWallClockToInstant(dueAtKey, at) };
}

/**
 * Every reminder a round has, resolved and classified, earliest first.
 *
 * Offsets sharing a resolved date are merged into ONE entry keeping the
 * EARLIEST instant of the group, so a same-day pair goes out at the earlier
 * of the two times rather than waiting for the later one. The merged entry is
 * one unit of work with one marker, which is what makes it one email.
 *
 * An offset that resolves PAST `closesAt` is dropped entirely rather than
 * returned as due, because there is no honest email to send from it.
 */
export function resolveReminderDueDates(input: {
  closesAt: Date | null;
  offsets: readonly ReminderOffsetLike[];
  now: Date;
  maxLateHours: number;
}): ReminderDue[] {
  const { closesAt, offsets, now, maxLateHours } = input;
  if (!closesAt || Number.isNaN(closesAt.getTime())) return [];

  const byKey = new Map<string, { dueAt: Date; offsetIds: string[] }>();
  for (const offset of offsets) {
    const { dueAtKey, dueAt } = reminderDueAt(closesAt, offset);
    // Past the deadline is not a reminder. Reachable through the offset's own
    // wall clock: a round closing at 09:00 with a deadline-day offset at
    // 12:00 would otherwise mail "applications close today, 09:00" three
    // hours after the form started refusing people.
    if (dueAt.getTime() > closesAt.getTime()) continue;
    const existing = byKey.get(dueAtKey);
    if (!existing) {
      byKey.set(dueAtKey, { dueAt, offsetIds: [offset.id] });
      continue;
    }
    existing.offsetIds.push(offset.id);
    if (dueAt.getTime() < existing.dueAt.getTime()) existing.dueAt = dueAt;
  }

  const out: ReminderDue[] = [];
  for (const [dueAtKey, { dueAt, offsetIds }] of byKey) {
    out.push({
      dueAtKey,
      dueAt,
      offsetIds,
      state:
        dueAt.getTime() > now.getTime()
          ? "pending"
          : isStaleWork(dueAt, now, maxLateHours)
            ? "stale"
            : "due",
    });
  }
  out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return out;
}
