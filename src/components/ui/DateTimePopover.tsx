"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./DateTimePopover.module.css";

type Props = {
  value: Date | null;
  onChange: (next: Date | null) => void;
  disabled?: boolean;
  /** Shown in the trigger when no date is selected. */
  placeholder?: string;
  /** Optional earliest allowed day in YYYY-MM-DD. */
  minDate?: string;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timeInput(d: Date | null): string {
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}

function formatTrigger(d: Date | null, placeholder: string): string {
  if (!d) return placeholder;
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 42 cells (6 weeks), Monday-first, covering the given month. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  return Array.from(
    { length: 42 },
    (_, i) => new Date(year, month, 1 - offset + i),
  );
}

/**
 * Date + time picker. The trigger shows the chosen day/time in plain English;
 * the popover is a hand-built month calendar plus a time field, themed to match
 * the app rather than relying on the browser's native date chrome.
 */
export default function DateTimePopover({
  value,
  onChange,
  disabled,
  placeholder = "Pick date & time…",
  minDate,
}: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const base = value ?? new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  function onTriggerClick() {
    // Jump the calendar to the selected month each time it opens.
    if (!open && value) {
      setView({ year: value.getFullYear(), month: value.getMonth() });
    }
    setOpen((o) => !o);
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const m = v.month + delta;
      return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });
  }

  function pickDay(day: Date) {
    // Keep the existing time, or default a fresh pick to 18:00.
    const [h, m] = (timeInput(value) || "18:00").split(":").map(Number);
    onChange(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m));
  }

  function onTimeInput(next: string) {
    const base = value ?? new Date();
    const [h, m] = (next || "00:00").split(":").map(Number);
    onChange(new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m));
  }

  const today = new Date();
  const minMs = minDate ? new Date(`${minDate}T00:00`).getTime() : null;
  const grid = monthGrid(view.year, view.month);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={onTriggerClick}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className={value ? styles.value : styles.placeholder}>
          {formatTrigger(value, placeholder)}
        </span>
        <span aria-hidden className={styles.chevron}>
          ▾
        </span>
      </button>

      {open && (
        <div role="dialog" aria-label="Pick date and time" className={styles.panel}>
          <div className={styles.calHeader}>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className={styles.calMonth}>
              {MONTHS[view.month]} {view.year}
            </span>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className={styles.weekRow}>
            {WEEKDAYS.map((w) => (
              <span key={w} className={styles.weekday}>
                {w}
              </span>
            ))}
          </div>

          <div className={styles.dayGrid}>
            {grid.map((day) => {
              const inMonth = day.getMonth() === view.month;
              const isSelected = value ? sameDay(day, value) : false;
              const tooEarly = minMs !== null && day.getTime() < minMs;
              const cls = [
                styles.day,
                inMonth ? "" : styles.dayOutside,
                sameDay(day, today) ? styles.dayToday : "",
                isSelected ? styles.daySelected : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  className={cls}
                  onClick={() => pickDay(day)}
                  disabled={disabled || tooEarly}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <div className={styles.timeRow}>
            <span className={styles.timeLabel}>Time</span>
            <input
              type="time"
              className={styles.timeInput}
              value={timeInput(value)}
              onChange={(e) => onTimeInput(e.target.value)}
              disabled={disabled || !value}
            />
          </div>

          <div className={styles.panelActions}>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              disabled={disabled || !value}
            >
              Clear
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
