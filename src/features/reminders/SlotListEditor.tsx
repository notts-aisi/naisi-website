"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import TimeField from "@/components/ui/TimeField";
import { reminderSlotInstant } from "@/lib/reminders/schedule";
import {
  newSlotId,
  REMINDER_SLOT_LIMITS,
  slotLabel,
  validateSlots,
  type ReminderSlot,
} from "@/lib/reminders/slots";
import styles from "./SlotListEditor.module.css";

/**
 * The reminder schedule, as a list of rows somebody can edit.
 *
 * ── ONE EDITOR, TWO FEATURES ────────────────────────────────────────────────
 * A worksheet circulation counts back from its due date and an admission
 * round counts back from its closing date, and that is the only difference
 * between them, so it is the only thing this takes as a prop. `anchorLabel`
 * ("the due date", "the closing date") is the noun phrase the row labels are
 * built around, which is why it is a phrase rather than a word: the copy
 * reads "3 days before the closing date at 10:00", and a component that took
 * "closing" would have to guess at the article and the noun.
 *
 * ── THE LABEL IS DERIVED, NEVER STORED ──────────────────────────────────────
 * `slotLabel` builds it from the numbers on every render. The schedule this
 * replaced had three fixed ids wearing three fixed names ("A week out"), so
 * an admin who edited one to four days was left with a row that said one
 * thing and sent another. A derived label cannot do that, and it is why the
 * label sits in the row rather than the row being titled.
 *
 * ── CONTROLLED, AND DELIBERATELY NOT SELF-SORTING ───────────────────────────
 * Every edit goes out through `onChange` and comes back as a prop, so the
 * parent decides whether that means a Firestore write now (the circulate
 * dialog, which is holding a draft anyway) or a Save button (the settings
 * panel, where a number field cannot honestly write per keystroke). Rows stay
 * in the order they were added rather than sorting themselves by day count:
 * a list that re-orders itself under a cursor is a list nobody can type in,
 * and the order means nothing to the scheduler, which resolves each slot to
 * an instant and works through them earliest first.
 *
 * ── VALIDATION SAYS, IT DOES NOT REPAIR ─────────────────────────────────────
 * `sanitizeSlots` repairs a list on the way out of Firestore, which is right
 * for a stored document. Under somebody's fingers it would be wrong: a
 * half-typed "1" on the way to "14" is not a mistake to correct, and a time
 * quietly rewritten is a schedule the author never chose. So the rows hold
 * whatever is typed, `validateSlots` says what is wrong in sentences, and the
 * parent refuses to save while there are any.
 *
 * An EMPTIED day box is the sharp edge of that rule. `Number("")` is 0, so
 * writing the parsed number straight back turned a cleared box into "0" under
 * the cursor, which is the repair this component says it does not do (and it
 * is the one repair with teeth: 0 means the day itself). The box therefore
 * keeps the raw text of whichever row is being typed in, the model carries
 * `NaN` while it is empty, and `validateSlots` refuses the list until a number
 * is there. One row's worth of raw text, because one box has focus at a time.
 *
 * ── A SLOT THAT COULD NEVER FIRE SAYS SO ────────────────────────────────────
 * The resolver drops any slot landing PAST the date it counts back from,
 * because there is no honest message to send from one. Only a 0-day slot can
 * manage it (anything a day or more out lands on an earlier date), and it is
 * easy to reach: a worksheet due at 09:00 with "on the due date at 12:00" is
 * a sentence the editor would otherwise confirm and the scheduler would
 * silently ignore. So the parent passes the anchor INSTANT as well as its
 * name, and the offending row says it would not be sent. A note rather than a
 * blocked save: the fix might be the due time rather than the reminder, and
 * the editor does not know which.
 */

type Props = {
  slots: ReminderSlot[];
  onChange: (next: ReminderSlot[]) => void;
  disabled?: boolean;
  /** "the due date" or "the closing date". Feeds every row's label. */
  anchorLabel: string;
  /**
   * The instant the rows count back FROM, when the parent has one.
   *
   * Optional because it only buys the "this one would never fire" note: a
   * parent with no date yet renders no editor at all, and a parent that has
   * not been updated to pass it loses the note and nothing else.
   */
  anchorAt?: Date | null;
};

/**
 * The row an Add button produces: the day before, at 10:00, moved further out
 * until it is not a duplicate of a row that already exists.
 *
 * Stepping rather than adding a duplicate because the alternative is an
 * editor that answers a button press with an error message about the row it
 * just made.
 */
function nextSlot(slots: ReminderSlot[]): ReminderSlot {
  const taken = new Set(slots.map((slot) => `${slot.daysBefore}@${slot.atLocalTime}`));
  let days = 1;
  while (taken.has(`${days}@10:00`) && days < REMINDER_SLOT_LIMITS.maxDaysBefore) {
    days += 1;
  }
  return { id: newSlotId(), daysBefore: days, atLocalTime: "10:00" };
}

export default function SlotListEditor({
  slots,
  onChange,
  disabled,
  anchorLabel,
  anchorAt,
}: Props) {
  // The raw text of the ONE day box being typed in. See the header: an empty
  // box is not a zero, and `Number("")` is.
  const [typing, setTyping] = useState<{ id: string; text: string } | null>(null);
  const problems = validateSlots(slots);
  const full = slots.length >= REMINDER_SLOT_LIMITS.maxSlots;
  const anchor = anchorAt && !Number.isNaN(anchorAt.getTime()) ? anchorAt : null;

  function update(id: string, fields: Partial<ReminderSlot>) {
    onChange(slots.map((slot) => (slot.id === id ? { ...slot, ...fields } : slot)));
  }

  function remove(id: string) {
    setTyping((held) => (held?.id === id ? null : held));
    onChange(slots.filter((slot) => slot.id !== id));
  }

  /**
   * Would the scheduler drop this row for landing past the date it counts back
   * from? Asked through the SAME resolver the job runs, so the note cannot
   * drift from the behaviour it is describing.
   */
  function wouldNotFire(slot: ReminderSlot): boolean {
    if (!anchor || !Number.isFinite(slot.daysBefore)) return false;
    return reminderSlotInstant(anchor, slot).dueAt.getTime() > anchor.getTime();
  }

  return (
    <div className={styles.editor}>
      {slots.length === 0 ? (
        <p className={styles.empty}>
          No reminders. Nobody is nudged before {anchorLabel}.
        </p>
      ) : (
        <ul className={styles.list}>
          {slots.map((slot, index) => (
            <li key={slot.id} className={styles.row}>
              {/* A NAMED GROUP, because every TimeField on the page announces
                  itself as "Time". Six rows of them are six identical names
                  with nothing to tell them apart, and the sentence that would
                  is a plain paragraph a screen reader meets afterwards. The
                  position is what makes the name stable while somebody types;
                  the sentence is the detail. */}
              <div
                className={styles.controls}
                role="group"
                aria-label={`Reminder ${index + 1}, ${slotLabel(slot, anchorLabel)}`}
              >
                {/* The label WRAPS the field, so there is no id to mint and
                    tapping the word reaches the box. */}
                <label className={styles.control}>
                  <span className={styles.controlLabel}>Days before</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={REMINDER_SLOT_LIMITS.maxDaysBefore}
                    step={1}
                    className={styles.days}
                    value={
                      typing?.id === slot.id
                        ? typing.text
                        : Number.isFinite(slot.daysBefore)
                          ? String(slot.daysBefore)
                          : ""
                    }
                    disabled={disabled}
                    onChange={(e) => {
                      // Held as typed, parsed alongside. An empty box carries
                      // `NaN` rather than 0, which `validateSlots` refuses and
                      // the row's own sentence names.
                      const text = e.target.value;
                      setTyping({ id: slot.id, text });
                      const trimmed = text.trim();
                      update(slot.id, {
                        daysBefore: trimmed === "" ? Number.NaN : Number(trimmed),
                      });
                    }}
                    onBlur={() =>
                      setTyping((held) => (held?.id === slot.id ? null : held))
                    }
                  />
                </label>
                <div className={styles.control}>
                  {/* TimeField carries its own "Time" label on its input, so
                      this is a caption rather than a second label for it. */}
                  <span className={styles.controlLabel} aria-hidden="true">
                    At
                  </span>
                  <div className={styles.time}>
                    <TimeField
                      value={slot.atLocalTime}
                      onChange={(next) => update(slot.id, { atLocalTime: next })}
                      disabled={disabled}
                    />
                  </div>
                </div>
              </div>
              <div className={styles.rowText}>
                <p className={styles.rowLabel}>{slotLabel(slot, anchorLabel)}</p>
                {wouldNotFire(slot) && (
                  <p className={styles.rowWarning}>
                    That is later than {anchorLabel} itself, so this one would not be
                    sent.
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => remove(slot.id)}
                disabled={disabled}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {problems.length > 0 && (
        <ul className={styles.problems} role="status">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className={styles.foot}>
        <Button
          type="button"
          variant="secondary"
          onClick={() => onChange([...slots, nextSlot(slots)])}
          disabled={disabled || full}
        >
          Add a reminder
        </Button>
        <span className={styles.count}>
          {full
            ? `${REMINDER_SLOT_LIMITS.maxSlots} is the most you can set.`
            : `Up to ${REMINDER_SLOT_LIMITS.maxSlots}. All times are London time.`}
        </span>
      </div>
    </div>
  );
}
