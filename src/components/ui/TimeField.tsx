"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./TimeField.module.css";

type Props = {
  /** "HH:MM" 24-hour, or "" when no time is set. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" (colon optional) into minutes since midnight, or null if invalid. */
function parse(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function format(mins: number): string {
  const v = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
}

/** 00:00, 00:15, … 23:45 — the quick-pick list. */
const QUARTERS: string[] = Array.from({ length: 96 }, (_, i) => format(i * 15));

/**
 * App-styled time field. The common case is one click on a quarter-hour from
 * the dropdown; the up/down steppers and the keyboard arrows fine-tune to the
 * minute, and a plain "HH:MM" can be typed. No browser-native time chrome.
 */
export default function TimeField({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mirror the text box when the value changes from outside (day pick,
  // stepper, quick-pick). Adjusting state during render, per the React docs,
  // rather than from an effect.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(value);
  }

  // Close the quick-pick list on an outside click, without closing any
  // popover this field is nested in.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Centre the current (or nearest) quarter when the list opens.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const mins = parse(value) ?? 18 * 60;
    const idx = Math.min(95, Math.round(mins / 15));
    const el = listRef.current;
    const opt = el.children[idx] as HTMLElement | undefined;
    if (opt) {
      el.scrollTop = opt.offsetTop - el.clientHeight / 2 + opt.offsetHeight / 2;
    }
  }, [open, value]);

  const current = parse(value);

  function step(delta: number) {
    onChange(format((current ?? 18 * 60) + delta));
  }

  function onTextChange(next: string) {
    setText(next);
    const parsed = parse(next);
    if (parsed !== null) onChange(format(parsed));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      step(-1);
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <input
        type="text"
        inputMode="numeric"
        className={styles.input}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onBlur={() => setText(value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="HH:MM"
        aria-label="Time"
      />
      <div className={styles.stepper}>
        <button
          type="button"
          className={styles.stepBtn}
          onClick={() => step(1)}
          disabled={disabled}
          aria-label="Later by one minute"
          tabIndex={-1}
        >
          ▲
        </button>
        <button
          type="button"
          className={styles.stepBtn}
          onClick={() => step(-1)}
          disabled={disabled}
          aria-label="Earlier by one minute"
          tabIndex={-1}
        >
          ▼
        </button>
      </div>
      <button
        type="button"
        className={styles.caret}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label="Pick a time"
        aria-expanded={open}
      >
        ▾
      </button>

      {open && (
        <div className={styles.list} ref={listRef}>
          {QUARTERS.map((q) => (
            <button
              type="button"
              key={q}
              className={
                q === value
                  ? `${styles.option} ${styles.optionActive}`
                  : styles.option
              }
              onClick={() => {
                onChange(q);
                setOpen(false);
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
