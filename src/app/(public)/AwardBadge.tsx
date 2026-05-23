"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AwardBadge.module.css";

/*
  UONSU Activities Awards — "Newcomer of the Year" badge, pinned to the
  hero top-right (and inline below the emblem on mobile via CSS).

  Behaviour:
    - Slides in from off-screen-right at t≈3500ms (after the headline settles).
    - Auto-shimmers once ~t=4500ms to draw the eye.
    - Hover triggers a re-shimmer.

  Links to the certificate PDF in public/brand/.
*/
export default function AwardBadge() {
  const [loaded, setLoaded] = useState(false);
  const [autoShine, setAutoShine] = useState(false);
  const shineTimer = useRef<number | null>(null);

  useEffect(() => {
    setLoaded(true);
    shineTimer.current = window.setTimeout(() => setAutoShine(true), 4500);
    return () => {
      if (shineTimer.current) window.clearTimeout(shineTimer.current);
    };
  }, []);

  return (
    <a
      className={`${styles.badge} ${loaded ? styles.loaded : ""} ${autoShine ? styles.autoShine : ""}`}
      href="/brand/naisi-newcomer-certificate.pdf"
      target="_blank"
      rel="noreferrer noopener"
      aria-label="UONSU Activities Awards 2026 — Newcomer of the Year. Open the certificate."
    >
      <span className={styles.iconWrap} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/uon-activities-awards-2026.png"
          alt=""
          className={styles.icon}
        />
      </span>
      <span className={styles.text}>
        <span className={styles.label}>Newcomer of the Year</span>
        <span className={styles.subline}>UONSU Activities Awards · 2026</span>
      </span>
    </a>
  );
}
