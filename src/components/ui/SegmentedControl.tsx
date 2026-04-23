"use client";

import type { ReactNode } from "react";
import styles from "./SegmentedControl.module.css";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Optional tooltip text on hover. */
  title?: string;
};

type Props<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
  /** Accessible group label for screen readers. */
  ariaLabel: string;
  size?: "sm" | "md";
  /** Active-pill colour: accent (default) or success (e.g. a live/approved state). */
  tone?: "accent" | "success";
};

/**
 * Radio-group-style segmented control — three-state pills that make escalating
 * tiers (none → draft → approve) visually obvious in a way two checkboxes
 * never could. Keyboard-accessible via native radios under the hood.
 */
export default function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  size = "md",
  tone = "accent",
}: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`${styles.group} ${styles[`size_${size}`]} ${styles[`tone_${tone}`]} ${disabled ? styles.disabled : ""}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <label
            key={opt.value}
            className={`${styles.option} ${active ? styles.active : ""}`}
            title={opt.title}
          >
            <input
              type="radio"
              className={styles.radio}
              checked={active}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
            />
            <span className={styles.optionLabel}>{opt.label}</span>
          </label>
        );
      })}
    </div>
  );
}
