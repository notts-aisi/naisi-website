"use client";

import Dropdown from "./Dropdown";
import { Select } from "./Input";
import styles from "./ResponsiveSelect.module.css";

/**
 * Drop-in replacement for the native `<Select>` from `./Input`. Renders
 * both shapes in the DOM and CSS-toggles which is visible at `--bp-md`:
 * native styled `<select>` above (proven, accessible, fast), Dropdown
 * bottom sheet below (the nicer touch UX).
 *
 * Single `value` / `onChange` source, options as an array (no `<option>`
 * children to write), per-option `disabled` first-class. The two task-
 * board surfaces (TaskCard chip + TaskBoardPhone filter) deliberately
 * skip this wrapper and stay on full Dropdown both viewports — they're
 * the desktop-popover test bed.
 */

export type ResponsiveSelectOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type Props<T extends string = string> = {
  value: T;
  onChange: (next: T) => void;
  options: ResponsiveSelectOption<T>[];
  /** Whole-control disabled. */
  disabled?: boolean;
  /** Required: selects must be labelled. */
  ariaLabel: string;
  /** Optional tooltip + native HTML title. */
  title?: string;
  /** Optional name for form serialization. Rare — current callsites are
   *  all controlled. */
  name?: string;
  /** Passthrough class on the trigger / select. */
  className?: string;
};

export default function ResponsiveSelect<T extends string = string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  title,
  name,
  className,
}: Props<T>) {
  return (
    <>
      <span className={styles.desktopShape}>
        <Select
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          disabled={disabled}
          aria-label={ariaLabel}
          title={title}
          name={name}
          className={className}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </Select>
      </span>
      <span className={styles.mobileShape}>
        <Dropdown<T>
          value={value}
          onChange={onChange}
          options={options}
          disabled={disabled}
          ariaLabel={ariaLabel}
          title={title}
          className={className}
        />
      </span>
    </>
  );
}
