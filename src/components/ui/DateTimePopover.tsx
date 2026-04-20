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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateToLocalDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateToLocalTimeInput(d: Date | null): string {
  if (!d) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parts(d: Date | null): { date: string; time: string } {
  return { date: dateToLocalDateInput(d), time: dateToLocalTimeInput(d) };
}

function combine(dateStr: string, timeStr: string): Date | null {
  if (!dateStr) return null;
  const time = timeStr || "00:00";
  const combined = new Date(`${dateStr}T${time}`);
  return Number.isNaN(combined.getTime()) ? null : combined;
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

/**
 * Bigger, popover-based date + time picker. The trigger button shows the
 * currently selected day/time in plain English; clicking opens a panel with
 * sized-up native date and time controls side-by-side.
 */
export default function DateTimePopover({
  value,
  onChange,
  disabled,
  placeholder = "Pick date & time…",
  minDate,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { date: dateStr, time: timeStr } = parts(value);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  function onDateInput(next: string) {
    onChange(combine(next, timeStr));
  }
  function onTimeInput(next: string) {
    onChange(combine(dateStr, next));
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
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
          <div className={styles.panelGrid}>
            <label className={styles.fieldLabel}>
              <span>Date</span>
              <input
                type="date"
                value={dateStr}
                min={minDate}
                onChange={(e) => onDateInput(e.target.value)}
                className={styles.input}
                disabled={disabled}
                autoFocus
              />
            </label>
            <label className={styles.fieldLabel}>
              <span>Time</span>
              <input
                type="time"
                value={timeStr}
                onChange={(e) => onTimeInput(e.target.value)}
                className={styles.input}
                disabled={disabled}
              />
            </label>
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
