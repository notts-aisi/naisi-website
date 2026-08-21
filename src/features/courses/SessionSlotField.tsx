"use client";

import { useId } from "react";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import TimeField from "@/components/ui/TimeField";
import { GROUP_FIELD_LIMITS } from "@/lib/firestore/courseGroups";
import styles from "./SessionSlotField.module.css";

/**
 * The recurring weekly slot editor — the gap `DateTimePopover` can't fill.
 * A group's session is not a dated instant, it is "every Tuesday at 18:00 for
 * 90 minutes", so there is no `Date` to pick; the three parts are edited
 * independently and stored on `courseGroups/{id}.session`.
 *
 * Composes the shipped primitives rather than inventing chrome:
 * `ResponsiveSelect` for the two enumerations (native select on desktop,
 * bottom sheet on touch) and `TimeField` for the wall clock.
 */

/** The three recurring-slot fields of `GroupSession`. */
export type SessionSlotValue = {
  /** 0 = Sunday .. 6 = Saturday — JS `Date.getDay()` convention. */
  weekday: number;
  /** "HH:MM" 24h wall clock in Europe/London. */
  startTimeLocal: string;
  durationMinutes: number;
};

type Props = {
  value: SessionSlotValue;
  onChange: (next: SessionSlotValue) => void;
  disabled?: boolean;
};

/**
 * Listed Monday-first because that is how a UK timetable reads, but the value
 * carried is the STORED number — `GroupSession.weekday`, JS `Date.getDay()`
 * convention where 0 = Sunday. Display order and stored number are
 * deliberately different things: do not "tidy" Sunday back to the top to make
 * them line up, or every existing session doc silently shifts by a day.
 */
const WEEKDAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

/** The three lengths a reading group / fellowship session actually runs. */
const DURATION_PRESETS = [60, 90, 120];

function durationLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (minutes > 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes} minutes`;
}

/**
 * "18:00" + 90 → "19:30". Wall-clock arithmetic for the summary line only —
 * this is display, not scheduling. The real instant for a given week comes
 * from `londonWallClockToInstant()` in `lib/courses/weekPlan.ts`, which is the
 * only thing allowed to reason about DST.
 */
function endTimeLabel(start: string, minutes: number): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m || minutes <= 0) return null;
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function SessionSlotField({ value, onChange, disabled }: Props) {
  const id = useId();

  // A stored duration that isn't one of the presets (an override typed in
  // Firestore, or a preset list that changes later) must still be selectable,
  // otherwise opening the editor would silently rewrite it on save.
  const durations = DURATION_PRESETS.includes(value.durationMinutes)
    ? DURATION_PRESETS
    : [...DURATION_PRESETS, value.durationMinutes]
        .filter((d) => d > 0 && d <= GROUP_FIELD_LIMITS.maxDurationMinutes)
        .sort((a, b) => a - b);

  const end = endTimeLabel(value.startTimeLocal, value.durationMinutes);
  const dayLabel =
    WEEKDAY_OPTIONS.find((o) => o.value === String(value.weekday))?.label ?? "";

  return (
    <div className={styles.root}>
      <div className={styles.grid}>
        <div className={styles.field}>
          <span className={styles.label} id={`${id}-day`}>
            Day
          </span>
          <ResponsiveSelect
            value={String(value.weekday)}
            onChange={(next) => onChange({ ...value, weekday: Number(next) })}
            options={WEEKDAY_OPTIONS}
            disabled={disabled}
            ariaLabel="Session day"
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label} id={`${id}-start`}>
            Starts (London)
          </span>
          <TimeField
            value={value.startTimeLocal}
            onChange={(next) => onChange({ ...value, startTimeLocal: next })}
            disabled={disabled}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label} id={`${id}-length`}>
            Length
          </span>
          <ResponsiveSelect
            value={String(value.durationMinutes)}
            onChange={(next) =>
              onChange({ ...value, durationMinutes: Number(next) })
            }
            options={durations.map((d) => ({
              value: String(d),
              label: durationLabel(d),
            }))}
            disabled={disabled}
            ariaLabel="Session length"
          />
        </div>
      </div>

      <p className={styles.summary}>
        {value.startTimeLocal && dayLabel ? (
          <>
            Meets <strong>{dayLabel}s</strong> at {value.startTimeLocal}
            {end ? `–${end}` : ""} London time.
          </>
        ) : (
          "Pick a day and start time to set the recurring slot."
        )}
      </p>
    </div>
  );
}

export default SessionSlotField;
