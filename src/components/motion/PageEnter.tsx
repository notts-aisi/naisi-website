"use client";

import { useEffect, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import styles from "./PageEnter.module.css";

/*
  PageEnter — the page-entrance primitive: PublicMain's inline-style + rAF
  FOUC handshake, generalised. The first paint carries an inline opacity:0 +
  from-transform so content is guaranteed invisible (SSR hydration or fresh
  client render alike); one animation frame later the class swap starts the
  CSS animation, whose from-state matches the inline style exactly, so the
  handoff is seamless on every browser including mobile Safari.

  Usage rules (the primitive is only correct when these hold):
  • Wraps page CONTENT, never layouts — soft navigations don't remount
    layouts, so a layout-level PageEnter would play once and never again.
  • Mount it on the FIRST render WITH data — the 3-state pattern: render a
    layout-matched Skeleton while loading, then EmptyState or
    PageEnter-wrapped content once data arrives. Never use animation-delay
    to "wait for data": a delay animates a guess, not an arrival.
*/

type Direction = "up" | "left" | "right";

type Props = {
  children: ReactNode;
  /** Direction the content TRAVELS as it enters. Default "up" (rises from
   *  10px below). "left" arrives from the right travelling leftward (use
   *  for forward/next navigation); "right" is the mirror (back/previous). */
  direction?: Direction;
  /** Element tag to render. Default div. */
  as?: ElementType;
  className?: string;
};

const fromTransform: Record<Direction, string> = {
  up: "translateY(10px)",
  left: "translateX(14px)",
  right: "translateX(-14px)",
};

const directionClass: Record<Direction, string> = {
  up: styles.enterUp,
  left: styles.enterLeft,
  right: styles.enterRight,
};

export default function PageEnter({
  children,
  direction = "up",
  as: Tag = "div",
  className,
}: Props) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    // One rAF so the inline from-state paint commits before the class swap;
    // without it the two paints can collapse into one, defeating the mask.
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const classes = [animate ? directionClass[direction] : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  // Only the pre-animation frame needs the inline mask; once the class
  // lands, the animation's from-state takes over.
  const initialStyle = !animate
    ? ({ opacity: 0, transform: fromTransform[direction] } as CSSProperties)
    : undefined;

  return (
    <Tag className={classes || undefined} style={initialStyle}>
      {children}
    </Tag>
  );
}
