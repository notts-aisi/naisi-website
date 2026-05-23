"use client";

import { motion } from "motion/react";
import styles from "./landing.module.css";

export default function HeroEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <motion.p
      className={styles.eyebrow}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.25, ease: "easeOut" }}
    >
      {children}
    </motion.p>
  );
}
