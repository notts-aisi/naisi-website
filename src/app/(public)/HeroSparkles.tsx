"use client";

import { useMemo } from "react";
import styles from "./HeroSparkles.module.css";

const SPARKLE_COUNT = 36;

/*
  Pure CSS sparkle layer — 36 single-pixel motes drift up over 18-30s
  loops. Positions and timings randomised once at mount (then stable).
  Reduced motion → motes render at fixed positions, no drift.
*/
export default function HeroSparkles() {
  const sparkles = useMemo(() => {
    return Array.from({ length: SPARKLE_COUNT }, (_, i) => {
      const left = Math.random() * 100;
      const startTop = 60 + Math.random() * 60; // start below or in the hero
      const duration = 18 + Math.random() * 14;
      const delay = -Math.random() * duration; // negative delay so they're mid-flight at mount
      const size = 1 + Math.random() * 1.5;
      const opacity = 0.4 + Math.random() * 0.45;
      return { i, left, startTop, duration, delay, size, opacity };
    });
  }, []);

  return (
    <div className={styles.layer} aria-hidden="true">
      {sparkles.map((s) => (
        <span
          key={s.i}
          className={styles.spark}
          style={{
            left: `${s.left}%`,
            top: `${s.startTop}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            opacity: s.opacity,
            animationDuration: `${s.duration}s`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
