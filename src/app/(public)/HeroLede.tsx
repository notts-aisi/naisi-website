"use client";

import { motion } from "motion/react";
import styles from "./landing.module.css";

export default function HeroLede({ children }: { children: React.ReactNode }) {
  return (
    <motion.p
      className={styles.lede}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 1.9, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.p>
  );
}
