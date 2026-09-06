/**
 * A reminder schedule, as a free list of slots, shared by every feature that
 * counts down to a date.
 *
 * ## One shape for two features, on purpose
 *
 * A worksheet circulation counts down to its `dueDate`; an admission round
 * counts down to its `closesAt`. Both had their own answer to "when do we
 * nudge people": the circulation had a fixed 48-hour window nobody could
 * change, and the round had three fixed slot ids (`t7`, `t3`, `dday`) whose
 * NAMES said seven, three and zero days while their numbers were editable, so
 * an edited slot wore the wrong label. This module is the one shape they now
 * share: a list of `{ daysBefore, atLocalTime }` with an opaque id, capped,
 * with the label derived from the numbers so it cannot lie.
 *
 * ## Why the id is opaque
 *
 * It exists to key a React list and to name a slot in a log line, nothing
 * else. NOTHING keys a send off it: the scheduler marker keys on the RESOLVED
 * date (and, for worksheets, the resolved wall clock), so editing a slot's
 * numbers cannot re-send a reminder that has already gone out, and two slots
 * that resolve to the same moment are one reminder rather than two. That is
 * the whole reason a stored id may be re-minted freely by {@link sanitizeSlots}
 * without anybody being mailed twice.
 *
 * ## This module has no imports
 *
 * It is read by client components (the two editors), by the Firestore
 * normalisers, and by the scheduler jobs, so it stays free of anything that
 * would drag `server-only` or the Admin SDK into a browser bundle. The date
 * arithmetic that turns a slot into an instant lives next door in
 * `./schedule.ts`, which does import the London helpers.
 */

/** One scheduled nudge, counted back from whatever date its feature anchors on. */
export type ReminderSlot = {
  /** Opaque, short, and never the key of anything that has been sent. */
  id: string;
  /** Whole days before the anchor date. 0 is the day itself. */
  daysBefore: number;
  /** London wall clock on that day, 24-hour "HH:MM". */
  atLocalTime: string;
};

/**
 * The budgets both editors enforce.
 *
 * `maxSlots` is six because a list is a list: three presets plus room for the
 * one somebody actually wanted, twice over. `maxDaysBefore` is sixty because a
 * reminder further out than two months is not a reminder, it is an
 * announcement, and because the worksheet job's scan uses this number as the
 * horizon it looks ahead to (see `worksheetDueReminders.ts`).
 */
export const REMINDER_SLOT_LIMITS = { maxSlots: 6, maxDaysBefore: 60 } as const;

/** 24-hour "HH:MM", the only time format any of this accepts. */
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A fresh slot id, in the shape `newBlockId()` uses for newsletter blocks:
 * a prefix, the clock in base 36, and six random characters. The clock alone
 * would collide for two slots added in the same millisecond, which is exactly
 * what "add three reminders" does when somebody leans on the button.
 */
export function newSlotId(): string {
  return `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The slot as a person reads it.
 *
 * With no `anchorLabel` it is the bare schedule ("3 days before at 10:00"),
 * which is what a log line or a summary wants. With one it names the date it
 * counts back from ("3 days before the due date at 10:00"), which is what the
 * editor shows, because "3 days before" on its own is a sentence with a hole
 * in it for anybody who has not just read the field above.
 *
 * Derived from the numbers rather than stored, so an edited slot cannot keep a
 * label describing what it used to be. That is the bug this whole module was
 * written to remove.
 *
 * A day count that is not a number at all gets a sentence saying so rather
 * than "NaN days before". That state is unreachable from a stored document
 * (`sanitizeSlots` drops it) and entirely reachable in the editor, where an
 * emptied day box is held as typed instead of snapping back to 0.
 */
export function slotLabel(slot: ReminderSlot, anchorLabel?: string): string {
  const at = slot.atLocalTime;
  if (!Number.isFinite(slot.daysBefore)) {
    return anchorLabel
      ? `Set how many days before ${anchorLabel} at ${at}`
      : `Set how many days before at ${at}`;
  }
  const days = Math.max(0, Math.round(slot.daysBefore));
  if (days === 0) {
    return anchorLabel ? `On ${anchorLabel} at ${at}` : `On the day at ${at}`;
  }
  const unit = days === 1 ? "day" : "days";
  const before = anchorLabel ? `before ${anchorLabel}` : "before";
  return `${days} ${unit} ${before} at ${at}`;
}

/** True when the pair is a schedule this platform can actually resolve. */
function isUsable(daysBefore: unknown, atLocalTime: unknown): boolean {
  return (
    typeof daysBefore === "number" &&
    Number.isFinite(daysBefore) &&
    typeof atLocalTime === "string" &&
    WALL_CLOCK.test(atLocalTime)
  );
}

/** The (daysBefore, atLocalTime) pair as one string, for de-duplication. */
function pairKey(slot: ReminderSlot): string {
  return `${slot.daysBefore}@${slot.atLocalTime}`;
}

/**
 * Whatever is stored, turned into a list this platform can send from.
 *
 * Called on EVERY read of a stored schedule, so the rules for what survives
 * are the rules for what a document may hold. In order:
 *
 *  - anything that is not an object, or whose day count is not a finite
 *    number, or whose time is not "HH:MM", is DROPPED. Dropped rather than
 *    defaulted: a time nobody can read is not a time to guess at, and the
 *    editor shows the surviving list, so a dropped row is visible rather than
 *    silently rescheduled to some hour nobody chose;
 *  - a day count outside 0..`maxDaysBefore` is CLAMPED, because a number
 *    that is merely too big says plainly what was meant;
 *  - a missing or duplicate id is RE-MINTED, which is safe because no send
 *    keys off an id (see the module header);
 *  - two slots with the same day count AND time are one slot, since they
 *    would resolve to one instant and therefore one reminder anyway;
 *  - the list is capped at `maxSlots`, keeping the first ones.
 *
 * `fallback` is returned, as fresh copies, when nothing valid survives. That
 * is what makes a document written before this feature existed gain the
 * defaults on read rather than fall silent, and the copies are what stop a
 * caller's edits reaching into the exported default constants.
 *
 * `allowEmpty` is the one exception, and it exists because BOTH features need
 * it and neither should own it. A document holding an EXPLICITLY EMPTY array
 * is not a document missing a schedule: it is somebody who opened the editor
 * and deleted every row. Falling back there would restore the defaults under
 * them and send mail they had just removed, so a normaliser reading a stored
 * document passes `allowEmpty: true` and an empty array stays empty. A caller
 * with no stored document behind it (a fresh draft, a test) leaves it off and
 * gets the fallback, which is the safe reading when there is no intent to
 * respect. Written here rather than in each normaliser because a rule about
 * consent that lives in two files is a rule that will only be fixed in one.
 */
export function sanitizeSlots(
  raw: unknown,
  fallback: ReminderSlot[],
  options?: { allowEmpty?: boolean },
): ReminderSlot[] {
  if (options?.allowEmpty && Array.isArray(raw) && raw.length === 0) return [];
  const out: ReminderSlot[] = [];
  if (Array.isArray(raw)) {
    const seenPairs = new Set<string>();
    const seenIds = new Set<string>();
    for (const entry of raw) {
      if (out.length >= REMINDER_SLOT_LIMITS.maxSlots) break;
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (!isUsable(e.daysBefore, e.atLocalTime)) continue;
      const days = Math.min(
        REMINDER_SLOT_LIMITS.maxDaysBefore,
        Math.max(0, Math.round(e.daysBefore as number)),
      );
      const slot: ReminderSlot = {
        id:
          typeof e.id === "string" && e.id && !seenIds.has(e.id) ? e.id : newSlotId(),
        daysBefore: days,
        atLocalTime: e.atLocalTime as string,
      };
      const key = pairKey(slot);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      seenIds.add(slot.id);
      out.push(slot);
    }
  }
  if (out.length > 0) return out;
  return fallback.map((slot) => ({ ...slot }));
}

/**
 * What is wrong with the list the editor is holding, in sentences.
 *
 * The editor's list is being TYPED, so it can hold states no stored document
 * ever should: a half-typed time, a day count of 900, two identical rows on
 * the way to being two different ones. `sanitizeSlots` would quietly repair
 * every one of those, which is right on the way in from Firestore and wrong
 * under somebody's fingers, so this says what is wrong instead and the editor
 * refuses to save until the list is clean.
 *
 * One sentence per KIND of problem rather than per row: a list with three bad
 * times has one thing wrong with it, and three copies of the same sentence is
 * a wall rather than a message.
 */
export function validateSlots(slots: ReminderSlot[]): string[] {
  const out: string[] = [];
  const outOfRange = slots.some(
    (slot) =>
      !Number.isFinite(slot.daysBefore) ||
      !Number.isInteger(slot.daysBefore) ||
      slot.daysBefore < 0 ||
      slot.daysBefore > REMINDER_SLOT_LIMITS.maxDaysBefore,
  );
  if (outOfRange) {
    out.push(
      `Days before must be a whole number between 0 and ${REMINDER_SLOT_LIMITS.maxDaysBefore}.`,
    );
  }
  if (slots.some((slot) => !WALL_CLOCK.test(slot.atLocalTime))) {
    out.push("A time must be a 24-hour clock time, like 10:00.");
  }
  const seen = new Set<string>();
  let duplicate = false;
  for (const slot of slots) {
    const key = pairKey(slot);
    if (seen.has(key)) duplicate = true;
    seen.add(key);
  }
  if (duplicate) {
    out.push("Two reminders are set for the same day and time. Change one, or remove it.");
  }
  if (slots.length > REMINDER_SLOT_LIMITS.maxSlots) {
    out.push(`Keep it to ${REMINDER_SLOT_LIMITS.maxSlots} reminders or fewer.`);
  }
  return out;
}

/**
 * The list as one string, ids excluded, for "has this changed" questions.
 *
 * Ids are excluded because a re-minted id is not an edit: `sanitizeSlots` may
 * mint one on the way in, and a panel that compared ids would light its Save
 * button up on a read.
 */
export function slotsSignature(slots: ReminderSlot[]): string {
  return slots.map(pairKey).join("|");
}

/**
 * A worksheet circulation's defaults: three days out, then the day before,
 * both at 10:00.
 *
 * Two rather than one because a worksheet is WORK, and the thing the reader
 * has to find is an evening: the three-day nudge is the one that can still be
 * acted on, and the one-day nudge is the one that gets acted on. 10:00 rather
 * than first thing, so it lands in a morning inbox that has already been
 * cleared rather than underneath the overnight pile.
 */
export const DEFAULT_WORKSHEET_SLOTS: ReminderSlot[] = [
  { id: "rs_ws3d", daysBefore: 3, atLocalTime: "10:00" },
  { id: "rs_ws1d", daysBefore: 1, atLocalTime: "10:00" },
];

/**
 * An admission round's defaults: the three presets the fixed ids used to
 * carry, in the same order and at the same times, so a round created after
 * this change is scheduled exactly as one created before it.
 */
export const DEFAULT_ROUND_SLOTS: ReminderSlot[] = [
  { id: "rs_rd7d", daysBefore: 7, atLocalTime: "10:00" },
  { id: "rs_rd3d", daysBefore: 3, atLocalTime: "10:00" },
  { id: "rs_rd0d", daysBefore: 0, atLocalTime: "12:00" },
];
