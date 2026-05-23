"use client";

import { motion } from "motion/react";
import styles from "./landing.module.css";

/*
  Renders the University of Nottingham logo where the eyebrow text used
  to be — the "University of Nottingham · AI Safety" line read as
  duplicative with the NAISI brand mark already in the public header.
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
        src="/brand/uon-logo.png"
        alt="The University of Nottingham"
        className={styles.eyebrowLogo}
      />
    </motion.div>
  );
}
