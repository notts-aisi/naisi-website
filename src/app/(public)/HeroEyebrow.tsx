"use client";

import { motion } from "motion/react";
import styles from "./landing.module.css";

/*
  NAISI emblem (no wordmark) at the top of the hero. Switched from the
  full lockup because the lockup's "Nottingham AI Safety Initiative"
  wordmark duplicated the headline's "From Nottingham." accent — the
  emblem alone carries identity without repeating copy.
*/
export default function HeroEyebrow() {
  return (
    <motion.div
      className={styles.eyebrow}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.25, ease: "easeOut" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/naisi-emblem.png"
        alt="Nottingham AI Safety Initiative"
        className={styles.eyebrowLogo}
      />
    </motion.div>
  );
}
