"use client";

import { useEffect, useState } from "react";
import styles from "./HeroSparkles.module.css";

const SPARKLE_COUNT = 36;

type Spark = {
  i: number;
  left: number;
  startTop: number;
  duration: number;
  delay: number;
  size: number;
  opacity: number;
};

/*
  Pure CSS sparkle layer — 36 single-pixel motes drift up over 18-30s
  loops. Positions and timings randomised once on the client after
  mount; the server renders an empty layer so SSR + client agree.
  Reduced motion → motes render at fixed positions, no drift.
*/
export default function HeroSparkles() {
  const [sparkles, setSparkles] = useState<Spark[]>([]);

  useEffect(() => {
    // Deliberate SSR-hydration pattern (see comment above): positions are
    // randomised once on the client, after mount, so SSR + client agree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSparkles(
      Array.from({ length: SPARKLE_COUNT }, (_, i) => {
        const duration = 18 + Math.random() * 14;
        return {
          i,
          left: Math.random() * 100,
          startTop: 60 + Math.random() * 60,
          duration,
          delay: -Math.random() * duration,
          size: 1 + Math.random() * 1.5,
          opacity: 0.4 + Math.random() * 0.45,
        };
      }),
    );
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
