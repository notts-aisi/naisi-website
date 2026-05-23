"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import styles from "./AwardBadge.module.css";

/*
  UONSU Activities Awards 2026 — "Newcomer of the Year" badge.
  Pinned below the hero CTAs as a trust signal next to the action.
  Motion-driven entrance (rises in after CTAs settle). Auto-shimmers
  once ~4.5s in to draw the eye, and on every hover thereafter.
*/
export default function AwardBadge() {
  const [autoShine, setAutoShine] = useState(false);
  const shineTimer = useRef<number | null>(null);

  useEffect(() => {
    shineTimer.current = window.setTimeout(() => setAutoShine(true), 4500);
    return () => {
      if (shineTimer.current) window.clearTimeout(shineTimer.current);
    };
  }, []);

  return (
    <motion.a
      className={`${styles.badge} ${autoShine ? styles.autoShine : ""}`}
      href="/brand/naisi-newcomer-certificate.pdf"
      target="_blank"
      rel="noreferrer noopener"
      aria-label="UONSU Activities Awards 2026 — Newcomer of the Year. Open the certificate."
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay: 2.9, ease: [0.22, 0.61, 0.36, 1] }}
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
    </motion.a>
  );
}
