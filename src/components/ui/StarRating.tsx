"use client";

import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { RATING_MAX, RATING_MIN } from "@/lib/firestore/courseProgress";
import styles from "./StarRating.module.css";

const STARS = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i);

/** Five-pointed star on a 20×20 grid, drawn once and reused outlined + filled. */
const STAR_PATH =
  "M10 1.6 12.6 6.9 18.4 7.75 14.2 11.84 15.19 17.6 10 14.88 4.81 17.6 5.8 11.84 1.6 7.75 7.4 6.9Z";

type Props = {
  value: number | null;
  onChange?: (n: number) => void;
  /**
   * Clearing a rating is its own action, not `onChange(0)` — 0 is outside
   * RATING_MIN..RATING_MAX and the stored field is absent-or-valid, never 0.
   * Omit this prop and Backspace/Delete stay unhandled.
   */
  onClear?: () => void;
  readOnly?: boolean;
  /**
   * `half` is DISPLAY-ONLY, for cohort averages: a radio cannot carry 4.5, and
   * rounding a member's own input would read it back to them as a lie. Passing
   * it forces the read-only presentation regardless of `readOnly`.
   */
  precision?: "int" | "half";
  ariaLabel: string;
  /** `md` = the 44px touch floor. `sm` is under it — read-only display only. */
  size?: "sm" | "md";
};

/**
 * Star rating input. Interactive form is a radiogroup of five native radios
 * behind star glyphs, the same hidden-input technique SegmentedControl uses.
 *
 * Keyboard is owned here rather than left to the browser's radio-group
 * navigation: arrows commit as they move (a rating you can focus but not
 * commit is a trap), and Home/End/1–5/Backspace have no native equivalent.
 * Every handled key calls `preventDefault` so native navigation cannot
 * double-act on top of it.
 *
 * The read-only form is `role="img"` with the value in its label, not a
 * radiogroup — a cohort average is a picture of a number, and announcing five
 * unselectable radios for it is noise.
 */
export default function StarRating({
  value,
  onChange,
  onClear,
  readOnly = false,
  precision = "int",
  ariaLabel,
  size = "md",
}: Props) {
  const name = useId();
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [popped, setPopped] = useState<number | null>(null);

  const interactive = !readOnly && precision === "int" && typeof onChange === "function";

  if (!interactive) {
    return (
      <div
        className={`${styles.group} ${styles[`size_${size}`]}`}
        role="img"
        aria-label={`${ariaLabel}: ${ratingText(value, precision)}`}
      >
        {STARS.map((n) => (
          <Star key={n} fill={fillFor(value, n, precision)} />
        ))}
      </div>
    );
  }

  const commit = (n: number) => {
    // Re-pressing the current value still pops — it confirms state — but must
    // not fire a redundant write.
    if (n !== value) onChange?.(n);
    // The pop is CSS-only and `onAnimationEnd` is what clears this latch, so
    // it must not be set when no animation will run: the module's
    // reduced-motion block sets `animation: none`, and a latched value would
    // then pin the class for the life of the component. Asked here rather than
    // handled with a timer because the CSS is already the authority — this
    // just asks it the same question.
    setPopped(prefersReducedMotion() ? null : n);
    inputRefs.current[n - RATING_MIN]?.focus();
  };

  const clear = () => {
    onClear?.();
    setPopped(null);
    inputRefs.current[0]?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Unrated sits one below the floor so ArrowRight lands on RATING_MIN.
    const current = value ?? RATING_MIN - 1;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        commit(Math.min(RATING_MAX, current + 1));
        return;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        commit(Math.max(RATING_MIN, current - 1));
        return;
      case "Home":
        e.preventDefault();
        commit(RATING_MIN);
        return;
      case "End":
        e.preventDefault();
        commit(RATING_MAX);
        return;
      case "Backspace":
      case "Delete":
        // Without onClear the caller isn't offering a clear; leave the key
        // to the browser rather than swallowing it silently.
        if (!onClear) return;
        e.preventDefault();
        clear();
        return;
    }
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= RATING_MIN && digit <= RATING_MAX) {
      e.preventDefault();
      commit(digit);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`${styles.group} ${styles[`size_${size}`]}`}
      onKeyDown={onKeyDown}
    >
      {STARS.map((n, i) => {
        const checked = value === n;
        return (
          <label
            key={n}
            className={`${styles.option} ${popped === n ? styles.pop : ""}`}
            onAnimationEnd={() => setPopped(null)}
          >
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="radio"
              name={name}
              className={styles.radio}
              checked={checked}
              // Roving tab stop — one entry point into the group. While
              // unrated it falls to the first star, which is otherwise the
              // case where browsers make every radio a tab stop.
              tabIndex={value === null ? (i === 0 ? 0 : -1) : checked ? 0 : -1}
              aria-label={n === 1 ? "1 star" : `${n} stars`}
              onChange={() => commit(n)}
            />
            <Star fill={n <= (value ?? 0) ? 1 : 0} />
          </label>
        );
      })}
    </div>
  );
}

/**
 * Read at commit time, never at render: this only ever gates a class set from
 * an event handler, so there is no hydration mismatch to guard against and no
 * listener to keep in sync.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** One star. `fill` is 0–1; anything between paints a clipped partial. */
function Star({ fill }: { fill: number }) {
  return (
    <span className={styles.star} aria-hidden="true">
      <svg className={styles.glyph} viewBox="0 0 20 20" fill="none">
        <path
          d={STAR_PATH}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {fill > 0 ? (
        <span
          className={styles.fill}
          style={{ "--star-fill": `${fill * 100}%` } as CSSProperties}
        >
          <svg className={styles.glyph} viewBox="0 0 20 20">
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

function shown(value: number, precision: "int" | "half"): number {
  return precision === "half" ? Math.round(value * 2) / 2 : Math.round(value);
}

function fillFor(value: number | null, star: number, precision: "int" | "half"): number {
  if (value === null) return 0;
  return Math.max(0, Math.min(1, shown(value, precision) - (star - 1)));
}

function ratingText(value: number | null, precision: "int" | "half"): string {
  if (value === null) return "not rated";
  return `${shown(value, precision)} out of ${RATING_MAX}`;
}
