import type { CSSProperties } from "react";
import styles from "./ProgressRing.module.css";

/**
 * ProgressRing — a circular completion token for card and node contexts
 * (the /learn hub's run cards, anywhere a "3 of 8" needs to read at a
 * glance inside a compact node).
 *
 * Deliberately a separate component from ProgressBar, not a variant: the
 * two have incompatible layout contracts. The bar fills a quantity inside
 * a flexible row (width: 100%, label slot, flex parent); the ring is a
 * fixed-size status token that sits IN a node. One component serving both
 * would grow a mode switch on every layout property.
 *
 * Same dasharray-constant technique as the WeekRail's node rings — r=13 in
 * a 32-unit viewBox, circumference hard-coded at 81.68 — so rail and ring
 * read as one family. The viewBox scales uniformly with `size`, and dash
 * maths in user units scale with it: no measurement at any size.
 */

type Props = {
  value: number;
  max: number;
  /** Rendered box in px. */
  size?: number;
  ariaLabel?: string;
  tone?: "accent" | "success";
};

/** 2π·13, to 2dp — the family constant shared with WeekRail's node rings. */
const CIRCUMFERENCE = 81.68;

export default function ProgressRing({
  value,
  max,
  size = 28,
  ariaLabel,
  tone = "accent",
}: Props) {
  const safeMax = Math.max(1, max);
  const clamped = Math.min(Math.max(0, value), safeMax);
  const offset = +(CIRCUMFERENCE * (1 - clamped / safeMax)).toFixed(2);

  return (
    /*
      role="img" + aria-label, NOT role="progressbar" + aria-value*: the
      progressbar role describes an operation in flight — screen readers
      present it as something loading and may re-announce value changes as
      if a process were running. This ring is a static status token, a fact
      about the thing it decorates ("3 of 8 weeks complete"), so the correct
      semantic is a named graphic, read once. Callers whose surrounding text
      already states the numbers omit `ariaLabel` and the SVG leaves the
      accessibility tree entirely.
    */
    <svg
      className={tone === "success" ? `${styles.ring} ${styles.success}` : styles.ring}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      focusable="false"
    >
      <circle className={styles.track} cx="16" cy="16" r="13" />
      {/* rotate(-90) starts the arc at 12 o'clock, matching the rail's
          completion sweep. The offset rides a CSS var so the mount keyframe
          can animate from empty to the computed value. */}
      <circle
        className={styles.fill}
        cx="16"
        cy="16"
        r="13"
        transform="rotate(-90 16 16)"
        style={{ "--ring-offset": offset } as CSSProperties}
      />
    </svg>
  );
}
