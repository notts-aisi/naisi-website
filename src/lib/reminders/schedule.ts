import {
  addDaysToKey,
  londonDateKey,
  londonWallClockToInstant,
} from "@/lib/courses/weekPlan";
import { isStaleWork } from "@/lib/firestore/schedulerMarkers";
import type { ReminderSlot } from "./slots";

/**
 * WHEN a list of reminder slots is due, worked out from the date it counts
 * back to, at TICK TIME.
 *
 * This is the admissions deadline-reminder resolver, lifted out of
 * `src/lib/admissions/reminderSchedule.ts` unchanged in behaviour so the
 * worksheet due-soon job can use the same one. That module now imports this
 * one and keeps its own exported names, so there is exactly ONE piece of
 * arithmetic deciding when a reminder is owed. The reasoning below is the
 * reasoning that was argued out there.
 *
 * ## Nothing is scheduled, so nothing has to be rescheduled
 *
 * There is no stored due list. Each tick reads the anchor date and the slots
 * and derives the instants again from scratch, which is what makes moving a
 * date free: an admin who pushes a deadline back a week moves every reminder
 * with it, and an admin who brings it forward moves them forward, without a
 * single stored row changing. The only thing that remembers anything is the
 * scheduler marker, and it remembers the RESOLVED MOMENT rather than the
 * slot's id.
 *
 * ## The marker keys on what was resolved, not on which slot resolved it
 *
 * Two consequences, both deliberate:
 *
 *  1. Editing the schedule cannot re-send. If the seven-day slot has gone out
 *     for 27 Sep and somebody then edits it to six days before, the new
 *     instant resolves to 28 Sep and is a genuinely different send. Keying on
 *     the slot id would have let an edit that resolved to the SAME moment
 *     re-mail everybody, which is the failure people notice.
 *  2. Two slots that resolve together are ONE send. What "together" means is
 *     the caller's choice, and it is the one thing the two features differ on:
 *     see {@link ReminderGrouping}.
 *
 * ## A reminder never resolves past the date it is counting down to
 *
 * A slot carries its own wall clock, so a day-of slot at 12:00 on a round
 * that closes at 09:00 resolves to three hours AFTER the form stopped
 * accepting anybody. That entry is dropped rather than sent: the email would
 * read "applications close today at 09:00" and link to a form that refuses
 * the reader.
 *
 * ## Europe/London, via the module the rest of the platform already uses
 *
 * `londonWallClockToInstant` is the fiddly one and it is already written,
 * tested and used by the week plan. 10:00 on 27 Sep 2026 is BST and 10:00 on
 * 27 Nov is GMT; deriving either by subtracting hours from a UTC instant gets
 * one of them wrong for half the year.
 */

/** The shape this module needs off one slot. {@link ReminderSlot} satisfies it. */
export type ReminderSlotLike = {
  id: string;
  /** Days before the anchor. 0 is the day itself. */
  daysBefore: number;
  /** London wall clock on that day, 24-hour "HH:MM". */
  atLocalTime: string;
};

/**
 * What counts as "the same reminder" when two slots both come due.
 *
 *  - `"day"`: slots resolving to the same London civil DATE are one send,
 *    taking the earlier of the two times. The admissions behaviour, and the
 *    reason a round closing on a Sunday with slots at 3 days and at 0 days
 *    over a three-day window mails an applicant once rather than twice.
 *  - `"instant"`: only slots resolving to the same MOMENT are one send. The
 *    worksheet behaviour, because a sender who deliberately sets a nudge at
 *    09:00 and another at 16:00 on the due day has asked for two, and a
 *    circulation is a small enough audience for that to be their call.
 *
 * The choice is also the shape of the marker key each feature carries, which
 * is why it belongs to the caller rather than to a constant here.
 */
export type ReminderGrouping = "day" | "instant";

/**
 * The wall clock used when a slot carries none.
 *
 * Both features validate `HH:MM` on the way in, so this is a floor rather
 * than a design decision: a document written by an older build, or by hand in
 * the console, can still reach a tick with a blank. 09:00 rather than
 * midnight because a reminder is a nudge to a person, and a nudge that lands
 * at 00:00 is read at 08:00 anyway with a night of unread mail on top of it.
 */
export const DEFAULT_REMINDER_TIME_LOCAL = "09:00";

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type ReminderDueState =
  /** Its instant is still ahead. Nothing to do this tick. */
  | "pending"
  /** Due, and inside the job's `maxLateHours`. Send it. */
  | "due"
  /** Due, and too long ago to be worth sending. */
  | "stale";

export type ResolvedReminder = {
  /**
   * The key this reminder is remembered by: the London civil date under
   * `"day"` grouping, and that date plus the wall clock under `"instant"`.
   * It is a scheduler marker id component verbatim, so it carries no `__`,
   * no `/` and no `.` (see `assertKeyComponent` in `schedulerMarkers.ts`).
   */
  dueAtKey: string;
  /** The instant the reminder becomes due. */
  dueAt: Date;
  /**
   * Every slot that resolved to this key, in the order the list gives them.
   * More than one means they collapsed onto one send.
   */
  slotIds: string[];
  state: ReminderDueState;
};

/** The civil date `daysBefore` days before the anchor, in London. */
export function reminderDateKey(anchor: Date, daysBefore: number): string {
  return addDaysToKey(londonDateKey(anchor), -Math.max(0, Math.floor(daysBefore)));
}

/**
 * The instant one slot resolves to: the anchor moved back `daysBefore` CIVIL
 * days in London, then set to the slot's local wall clock.
 *
 * Civil days rather than 24-hour blocks: a clock change inside the window
 * would otherwise drift the reminder by an hour and, on a reminder timed for
 * midnight, by a day.
 */
export function reminderSlotInstant(
  anchor: Date,
  slot: ReminderSlotLike,
): { dateKey: string; atLocalTime: string; dueAt: Date } {
  const dateKey = reminderDateKey(anchor, slot.daysBefore);
  const atLocalTime = WALL_CLOCK.test(slot.atLocalTime)
    ? slot.atLocalTime
    : DEFAULT_REMINDER_TIME_LOCAL;
  return { dateKey, atLocalTime, dueAt: londonWallClockToInstant(dateKey, atLocalTime) };
}

/**
 * The marker key for one resolved slot under one grouping.
 *
 * The `"instant"` form is the date with the clock appended and the colon
 * dropped (`2026-10-04T1000`): a marker id component may not contain `__`,
 * and every other separator on hand reads as punctuation in a date. Two
 * reminders on one day at different times are therefore two keys and two
 * sends; the same time twice is one key and one send.
 */
function keyFor(dateKey: string, atLocalTime: string, grouping: ReminderGrouping): string {
  return grouping === "day" ? dateKey : `${dateKey}T${atLocalTime.replace(":", "")}`;
}

/**
 * Every reminder a schedule has, resolved and classified, earliest first.
 *
 * Slots sharing a key are merged into ONE entry keeping the EARLIEST instant
 * of the group, so a same-key pair goes out at the earlier of the two times
 * rather than waiting for the later one. The merged entry is one unit of work
 * with one marker, which is what makes it one email.
 *
 * A slot that resolves PAST the anchor is dropped entirely rather than
 * returned as due, because there is no honest email to send from it.
 */
export function resolveReminderSlots(input: {
  anchor: Date | null;
  slots: readonly ReminderSlotLike[];
  now: Date;
  maxLateHours: number;
  /** Defaults to `"day"`, which is the behaviour admissions shipped with. */
  grouping?: ReminderGrouping;
}): ResolvedReminder[] {
  const { anchor, slots, now, maxLateHours } = input;
  const grouping = input.grouping ?? "day";
  if (!anchor || Number.isNaN(anchor.getTime())) return [];

  const byKey = new Map<string, { dueAt: Date; slotIds: string[] }>();
  for (const slot of slots) {
    const { dateKey, atLocalTime, dueAt } = reminderSlotInstant(anchor, slot);
    // Past the anchor is not a reminder. Reachable through the slot's own wall
    // clock: a round closing at 09:00 with a day-of slot at 12:00 would
    // otherwise mail "applications close today, 09:00" three hours after the
    // form started refusing people.
    if (dueAt.getTime() > anchor.getTime()) continue;
    const key = keyFor(dateKey, atLocalTime, grouping);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { dueAt, slotIds: [slot.id] });
      continue;
    }
    existing.slotIds.push(slot.id);
    if (dueAt.getTime() < existing.dueAt.getTime()) existing.dueAt = dueAt;
  }

  const out: ResolvedReminder[] = [];
  for (const [dueAtKey, { dueAt, slotIds }] of byKey) {
    out.push({
      dueAtKey,
      dueAt,
      slotIds,
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

/** Re-exported so a caller can type a list without reaching for two modules. */
export type { ReminderSlot };
