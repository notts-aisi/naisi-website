"use client";

import { Children, isValidElement, cloneElement, type ReactNode, type CSSProperties, type ElementType } from "react";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import styles from "./Reveal.module.css";

type Variant = "fade-rise" | "blur-rise" | "mask-wipe" | "tilt-in" | "spring-overshoot";

type Props = {
  children: ReactNode;
  /** Visual reveal style. Default: fade-rise. */
  variant?: Variant;
  /** When true, stagger direct children using --stagger-index. */
  staggerChildren?: boolean;
  /** Stagger spacing in ms when staggerChildren is true. Default 90. */
  staggerMs?: number;
  /** Element tag to render. Default div. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  id?: string;
};

const variantClass: Record<Variant, string> = {
  "fade-rise": styles.fadeRise,
  "blur-rise": styles.blurRise,
  "mask-wipe": styles.maskWipe,
  "tilt-in": styles.tiltIn,
  "spring-overshoot": styles.spring,
};

/*
  Reveal — drives below-the-fold entrance via a class toggle on first
  in-view. Class-based (rather than data-attribute) so it works
  uniformly on every browser, including mobile Safari. Reduced-motion
  is honoured via Reveal.module.css.
*/
export default function Reveal({
  children,
  variant = "fade-rise",
  staggerChildren = false,
  staggerMs = 90,
  as: Tag = "div",
  className,
  style,
  id,
}: Props) {
  const { ref, inView } = useInViewOnce<HTMLElement>();

  const classes = [
    styles.reveal,
    variantClass[variant],
    staggerChildren ? styles.staggered : "",
    inView ? styles.revealed : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const renderedChildren = staggerChildren
    ? Children.map(children, (child, i) => {
        if (!isValidElement(child)) return child;
        const childProps = child.props as { style?: CSSProperties };
        return cloneElement(child as React.ReactElement<{ style?: CSSProperties }>, {
          style: {
            ...(childProps.style ?? {}),
            "--stagger-index": i,
          } as CSSProperties,
        });
      })
    : children;

  const mergedStyle = {
    ...style,
    "--stagger-ms": `${staggerMs}ms`,
  } as CSSProperties;

  return (
    <Tag ref={ref} id={id} className={classes} style={mergedStyle}>
      {renderedChildren}
    </Tag>
  );
}
