"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useMagneticPull } from "@/hooks/useMagneticPull";
import styles from "./landing.module.css";

/*
  Hero CTAs — motion-driven entrance (rise with subtle overshoot spring)
  + magnetic-pull on hover. The magnetic --mag-x/--mag-y CSS variables
  are written by the useMagneticPull hook and applied via `translate:`
  in landing.module.css, which stacks with motion's transform output.
*/
export default function HeroCTAs() {
  const primaryRef = useMagneticPull<HTMLAnchorElement>({ radius: 130, strength: 0.18, cap: 8 });
  const secondaryRef = useMagneticPull<HTMLAnchorElement>({ radius: 130, strength: 0.14, cap: 6 });

  return (
    <div className={styles.ctas}>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 2.5, type: "spring", stiffness: 320, damping: 20 }}
      >
        <Link ref={primaryRef} href="/register" className={styles.primaryCta}>
          Apply to join
        </Link>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 2.6, type: "spring", stiffness: 320, damping: 20 }}
      >
        <Link ref={secondaryRef} href="#stay-in-touch" className={styles.secondaryCta}>
          Get the newsletter →
        </Link>
      </motion.div>
    </div>
  );
}
