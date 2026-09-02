"use client";

import Link from "next/link";
import { motion } from "motion/react";
import JoinMenu from "@/components/ui/JoinMenu";
import { SU_PAGE_URL } from "@/content/socials";
import { useTilt } from "@/hooks/useTilt";
import styles from "./landing.module.css";

/*
  Hero CTAs — motion-driven entrance (rise with subtle overshoot spring)
  + tilt-on-hover via useTilt. Tilt is the same depth signal used by
  the Instagram / Elsewhere cards further down the page; we previously
  used a magnetic-pull + diagonal-shimmer combination but the shimmer
  visibly reversed itself on hover-out and stuttered when the cursor
  ran from one CTA to the next.
*/
export default function HeroCTAs() {
  // The primary CTA is now a JoinMenu (a <button>), so it no longer takes the
  // anchor tilt ref — selecting opens the UoN-vs-collaborator chooser (popover
  // on desktop, bottom sheet on mobile).
  const secondaryRef = useTilt<HTMLAnchorElement>({ max: 6, perspective: 900 });
  const tertiaryRef = useTilt<HTMLAnchorElement>({ max: 6, perspective: 900 });

  return (
    <div className={styles.ctas}>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 2.5, type: "spring", stiffness: 320, damping: 20 }}
      >
        <JoinMenu className={styles.primaryCta} label="Apply to our platform" />
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
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 2.7, type: "spring", stiffness: 320, damping: 20 }}
      >
        <a
          ref={tertiaryRef}
          href={SU_PAGE_URL}
          target="_blank"
          rel="noreferrer noopener"
          className={styles.secondaryCta}
        >
          Join the society for £6 →
        </a>
      </motion.div>
    </div>
  );
}
