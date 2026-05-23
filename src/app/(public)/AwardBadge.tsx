"use client";

import { motion } from "motion/react";
import styles from "./AwardBadge.module.css";

/*
  UONSU Activities Awards 2026 — "Newcomer of the Year" badge. Sits
  below the hero headline as a trust signal. Motion-driven entrance
  (rises in shortly after the headline settles). Gold shimmer sweep
  fires on hover; auto-shine on load was removed because the sweep
  was rendering against the .hero ancestor and rushing across the
  whole viewport on every page load.
*/
export default function AwardBadge() {
  return (
    <motion.a
      className={styles.badge}
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
