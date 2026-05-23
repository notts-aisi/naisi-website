"use client";

import { motion } from "motion/react";
import styles from "./landing.module.css";

/*
  Hero emblem with a motion-driven entrance. The positional centering
  is done via top:50% + margin-top:-110px in CSS so motion's y transform
  doesn't fight it.
*/
export default function HeroEmblem() {
  return (
    <motion.div
      className={styles.heroArt}
      aria-hidden="true"
      initial={{ opacity: 0, y: 28, rotate: -1.5 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{
        duration: 0.9,
        delay: 0.1,
        ease: [0.22, 1.2, 0.36, 1],
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/naisi-emblem.png" alt="" width={180} height={220} />
    </motion.div>
  );
}
