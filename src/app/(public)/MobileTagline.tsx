"use client";

import { motion } from "motion/react";
import styles from "./landing.module.css";

/*
  Mobile-only tagline that sits in the hero. Reads as "this is who we
  are" since the hero emblem is hidden on mobile (PublicHeader's
  BrandMark already provides identity).
*/
export default function MobileTagline() {
  return (
    <motion.p
      className={styles.mobileTagline}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.35, ease: "easeOut" }}
    >
      Nottingham AI Safety Initiative
    </motion.p>
  );
}
