"use client";

import { useEffect, useState } from "react";
import styles from "./ProgressBar.module.css";

type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

type Props = {
  value: number;
  max: number;
  ariaLabel?: string;
  tone?: Tone;
  showLabel?: boolean;
  size?: "sm" | "md";
  /** When true, the first client paint is scaleX(0) and one rAF later the
   *  fill transitions to the real value. Off by default so existing
   *  consumers keep their static first paint. */
  animateOnMount?: boolean;
};

const toneClass: Record<Tone, string> = {
  neutral: styles.toneNeutral,
  accent: styles.toneAccent,
  success: styles.toneSuccess,
  danger: styles.toneDanger,
  warning: styles.toneWarning,
};

/*
  Fill is a full-width inner div scaled via transform: scaleX() — never an
  animated width, which relayouts on every frame. The mount animation reuses
  the PublicMain rAF handshake: render the from-state (scaleX(0)) first, flip
  on the next frame so the two paints can't collapse into one.
*/
export default function ProgressBar({
  value,
  max,
  ariaLabel,
  tone = "accent",
  showLabel = false,
  size = "md",
  animateOnMount = false,
}: Props) {
  const safeMax = Math.max(1, max);
  const clamped = Math.max(0, Math.min(value, safeMax));
  const [drawn, setDrawn] = useState(!animateOnMount);

  useEffect(() => {
    if (drawn) return;
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [drawn]);

  return (
    <div className={styles.wrap}>
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        className={`${styles.track} ${size === "sm" ? styles.sm : styles.md}`}
      >
        <div
          className={`${styles.fill} ${toneClass[tone]}`}
          style={{ transform: `scaleX(${drawn ? clamped / safeMax : 0})` }}
        />
      </div>
      {showLabel && (
        <span className={styles.label}>
          {clamped}/{max}
        </span>
      )}
    </div>
  );
}
