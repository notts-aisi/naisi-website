"use client";

import type { CSSProperties, ElementType } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const EASE = [0.22, 0.61, 0.36, 1] as const;

/**
 * Crossfades between values whenever `text` changes — blur + fade + a small
 * vertical drift, with the outgoing value popped out of layout (`popLayout`) so
 * the new one slides straight in with no empty gap. Used for the /register
 * heading + subline. A crossfade (rather than a per-letter cascade) stays clean
 * even while the card around it is re-laying-out on a mode switch — the cascade
 * read as jittery because it played WHILE the card shifted. Honours reduced
 * motion + SSR (renders statically); no first-mount animation, so nothing
 * flashes in on page load.
 */
export default function AnimatedText({
  text,
  as = "div",
  className,
  style,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
}) {
  const reduced = useReducedMotion();
  const Tag = as;

  if (reduced) {
    return (
      <Tag className={className} style={style}>
        {text}
      </Tag>
    );
  }

  return (
    <Tag className={className} style={{ position: "relative", ...style }} aria-label={text}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          aria-hidden="true"
          style={{ display: "inline-block", willChange: "transform, opacity, filter" }}
          initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -6, filter: "blur(6px)" }}
          transition={{ duration: 0.3, ease: EASE }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </Tag>
  );
}
