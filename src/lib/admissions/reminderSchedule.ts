import {
  DEFAULT_REMINDER_TIME_LOCAL,
  reminderDateKey,
  reminderSlotInstant,
  resolveReminderSlots,
  type ReminderDueState,
  type ReminderSlotLike,
} from "@/lib/reminders/schedule";

/**
 * WHEN a round's deadline reminders are due, worked out from the round's own
 * `closesAt` at TICK TIME.
 *
 * ## This module is now a name, not an implementation
 *
 * The arithmetic moved to `src/lib/reminders/schedule.ts` when the worksheet
 * due-soon job needed exactly the same answer about a circulation's due date.
 * Two resolvers for "is this reminder owed yet" is one resolver too many: the
 * second copy is the one that quietly stops matching the first, on the day
 * somebody fixes a clock-change bug in whichever they happened to open.
 *
 * What stays here is the admissions VOCABULARY: `closesAt`, `offsets`,
 * `offsetIds`. Every name and every behaviour below is unchanged, so the
 * deadline-reminder job and its suite read exactly as they did; the reasoning
 * they were written against now lives in the shared module's header, and the
 * parts of it that are specifically about a round are kept below.
 *
 * ## The marker keys on the resolved civil date, not on the offset id
 *
 * `remind__{roundId}__{uid}__{dueAtKey}` where `dueAtKey` is the London civil
 * date the reminder resolved to. Two consequences, both deliberate:
 *
 *  1. Editing the schedule cannot re-send. If a seven-day offset has gone out
 *     for 27 Sep and somebody then edits it to 6 days before, the new instant
 *     resolves to 28 Sep and is a genuinely different send.
 *  2. Two offsets that resolve to the same DAY are ONE send. A round closing
 *     on a Sunday with offsets at 3 days and at 0 days on a three-day window
 *     can collapse; the applicant gets one email that day rather than two.
 *     That is the `"day"` grouping in the shared resolver, and it is what
 *     this module passes.
 *
 * ## A reminder never resolves past the deadline it is counting down to
 *
 * An offset carries its own wall clock, so a deadline-day offset at 12:00 on
 * a round that closes at 09:00 resolves to three hours AFTER the form stopped
 * accepting anybody. That entry is dropped rather than sent. The job
 * additionally gates the whole round on `isRoundOpen`
 * (`src/lib/admissions/window.ts`), so the two halves agree.
 */

/** The shape this module needs off a round's `reminderOffsets` entry. */
export type ReminderOffsetLike = ReminderSlotLike;

export { DEFAULT_REMINDER_TIME_LOCAL };
export type { ReminderDueState };

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
  return reminderDateKey(closesAt, daysBefore);
}

/**
 * The instant one offset resolves to: `closesAt` moved back `daysBefore`
 * CIVIL days in London, then set to the offset's local wall clock.
 */
export function reminderDueAt(
  closesAt: Date,
  offset: ReminderOffsetLike,
): { dueAtKey: string; dueAt: Date } {
  const { dateKey, dueAt } = reminderSlotInstant(closesAt, offset);
  return { dueAtKey: dateKey, dueAt };
}

/**
 * Every reminder a round has, resolved and classified, earliest first.
 *
 * Grouped by DAY, which is the behaviour every round has shipped with: two
 * offsets landing on one date are one email, at the earlier of the two times.
 */
export function resolveReminderDueDates(input: {
  closesAt: Date | null;
  offsets: readonly ReminderOffsetLike[];
  now: Date;
  maxLateHours: number;
}): ReminderDue[] {
  return resolveReminderSlots({
    anchor: input.closesAt,
    slots: input.offsets,
    now: input.now,
    maxLateHours: input.maxLateHours,
    grouping: "day",
  }).map((entry) => ({
    dueAtKey: entry.dueAtKey,
    dueAt: entry.dueAt,
    offsetIds: entry.slotIds,
    state: entry.state,
  }));
}
