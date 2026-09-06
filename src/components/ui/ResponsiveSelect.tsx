"use client";

import { useSyncExternalStore } from "react";
import Dropdown from "./Dropdown";
import { Select } from "./Input";
import { maxWidth } from "@/theme/breakpoints";
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

/**
 * Which shape the browser is actually showing, mirroring this module's own
 * CSS switch at `--bp-md`.
 *
 * Only `required` has to know. A hidden `<select required>` is still a
 * candidate for constraint validation, so arming it below the breakpoint
 * would block the form's submit event with nothing on screen to explain it:
 * the browser cannot focus a `display: none` control to report on, and the
 * page's own "fill in every required field" message never runs because the
 * submit handler never fires.
 */
const SHEET_QUERY = maxWidth("md");
const subscribeSheet = (onChange: () => void) => {
  const mq = window.matchMedia(SHEET_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
const sheetSnapshot = () => window.matchMedia(SHEET_QUERY).matches;
const sheetServerSnapshot = () => false;

type Props<T extends string = string> = {
  value: T;
  onChange: (next: T) => void;
  options: ResponsiveSelectOption<T>[];
  /** Whole-control disabled. */
  disabled?: boolean;
  /** Required: selects must be labelled. */
  ariaLabel: string;
  /**
   * DOM id for the native shape only. Lets a caller point an explicit
   * `<label htmlFor>` at the control instead of wrapping it, which matters
   * wherever help text or a validation message sits in the same field: a
   * wrapping label would swallow those into the control's accessible name.
   * Deliberately NOT applied to the sheet shape as well, because both shapes
   * are in the DOM at once and two elements cannot share an id.
   *
   * So below `--bp-md` the id sits on a `display: none` element and the
   * caller's label click still focuses nothing, and the sheet trigger carries
   * no `aria-required` either, because `Dropdown` accepts neither prop today.
   * Both are the same one-component fix: give `Dropdown` an optional `id` and
   * `required` and put them on its combobox trigger, which is a `button` and
   * takes `aria-required` legitimately. Until then the sheet is labelled by
   * its own `ariaLabel` and an empty required field is caught by the form's
   * submit handler rather than by the browser.
   */
  id?: string;
  /**
   * Native `required`, and only ever on the shape that is on screen (see
   * `SHEET_QUERY` above). The sheet shape is a button rather than a form
   * control, so below `--bp-md` an empty field is caught by the form's own
   * submit handler instead of by the browser.
   */
  required?: boolean;
  /** Ids of the help / error text describing this control. Reaches both shapes. */
  describedBy?: string;
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
  id,
  required,
  describedBy,
}: Props<T>) {
  const isSheet = useSyncExternalStore(
    subscribeSheet,
    sheetSnapshot,
    sheetServerSnapshot,
  );
  return (
    <>
      <span className={styles.desktopShape}>
        <Select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          disabled={disabled}
          required={required === true && !isSheet}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
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
          describedBy={describedBy}
          title={title}
          className={className}
        />
      </span>
    </>
  );
}
