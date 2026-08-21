"use client";

import styles from "./MaterialCheck.module.css";

/**
 * The 44px check-off control — rendered into WeekCurriculum's
 * `renderMaterialAction` / `renderChecklistAction` slots by WeekView.
 *
 * Controlled and stateless on purpose: `checked` is the caller's OPTIMISTIC
 * value (WeekView flips it before the Firestore write settles — the plan's
 * check-off choreography never waits for the network), and every visual
 * transition below is driven purely by the class flip between the two states.
 * That is what makes the whole gesture interruptible: a failure revert flips
 * the class back and the CSS reverses from wherever it had got to; an initial
 * render with `checked` already true paints the final state with no
 * transition, because transitions don't run on first style application.
 *
 * Draw timeline (plan: "Check-off choreography"; timings in the module CSS):
 * press scale(0.92) over --dur-tap → ring sweep draws 260ms (--dur-settle)
 * → tick draws 200ms overlapping from t=60ms, so ring and tick read as one
 * gesture. Uncheck reverses faster (--dur-quick), no flourish. Row-level
 * effects (wash, title dim, panel open, failure flash) are WeekView's job —
 * this component owns nothing outside its own 44px box.
 *
 * Ring r=13 in a 32-unit viewBox — circumference 81.68, the family constant
 * shared with WeekRail's nodes and ProgressRing, so the three read as one
 * system. The tick carries pathLength={100} so its dash maths are a
 * compile-time constant (the WeekRail technique), never a measurement.
 */

type Props = {
  checked: boolean;
  /** Accessible name — the item's title. State itself rides `aria-checked`. */
  label: string;
  /** Read-only presentation (completed enrolment, un-enrolled admin). */
  disabled?: boolean;
  /** Called with the state being moved TO. Caller flips optimistically. */
  onToggle: (next: boolean) => void;
};

export default function MaterialCheck({
  checked,
  label,
  disabled = false,
  onToggle,
}: Props) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={checked ? `${styles.check} ${styles.isChecked}` : styles.check}
      onClick={() => onToggle(!checked)}
    >
      <span className={styles.disc} aria-hidden="true">
        <svg className={styles.glyph} viewBox="0 0 32 32" focusable="false">
          <circle className={styles.outline} cx="16" cy="16" r="13" />
          {/* rotate(-90) starts the sweep at 12 o'clock — same convention as
              WeekRail's completed rings and ProgressRing's fill arc. */}
          <circle
            className={styles.sweep}
            cx="16"
            cy="16"
            r="13"
            transform="rotate(-90 16 16)"
          />
          <path
            className={styles.tick}
            d="M10.8 16.8 L14.4 20.2 L21.4 12.6"
            pathLength={100}
          />
        </svg>
      </span>
    </button>
  );
}
