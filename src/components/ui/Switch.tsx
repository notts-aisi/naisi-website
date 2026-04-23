"use client";

import type { ReactNode } from "react";
import styles from "./Switch.module.css";

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  disabled?: boolean;
  /** Main label text, rendered next to the switch. */
  label: ReactNode;
  /** Optional secondary line under the label. */
  description?: ReactNode;
  /** ARIA / visual tone. "accent" = primary switch; "success" = e.g. a subscribe toggle. */
  tone?: "accent" | "success";
  /** Size variant. `lg` is for standalone toggles; `md` (default) for in-list rows. */
  size?: "md" | "lg";
};

/**
 * Accessible switch toggle — replaces raw `<input type="checkbox">` on the
 * profile + admin pages. Looks like iOS/macOS toggles: track pill + knob.
 * Native <input> retained under the hood for form submission + screen readers.
 */
export default function Switch({
  checked,
  onChange,
  id,
  disabled,
  label,
  description,
  tone = "accent",
  size = "md",
}: Props) {
  return (
    <label
      className={`${styles.row} ${styles[`size_${size}`]} ${disabled ? styles.disabled : ""}`}
    >
      <span className={`${styles.track} ${checked ? styles[`on_${tone}`] : ""}`}>
        <input
          id={id}
          type="checkbox"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles.knob} aria-hidden />
      </span>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description && <span className={styles.description}>{description}</span>}
      </span>
    </label>
  );
}
