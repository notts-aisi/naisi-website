import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Chip.module.css";

export type ChipTone = "neutral" | "accent" | "success" | "danger" | "warning";
export type ChipSize = "sm" | "md";

type Props = HTMLAttributes<HTMLSpanElement> & {
  tone?: ChipTone;
  size?: ChipSize;
  children: ReactNode;
  /** Native tooltip — the escape hatch for chips whose label is abbreviated. */
  title?: string;
};

/**
 * Small status/label pill. `size="md"` renders exactly what Badge always has
 * (Badge is now a wrapper around it); `size="sm"` is for dense rows where a
 * chip is a marker rather than a heading — roster cells, week strips.
 *
 * Chips that are themselves interactive pass `data-interactive="true"` for the
 * hover ring, and `tabIndex={0}` if they take focus.
 */
export default function Chip({
  tone = "neutral",
  size = "md",
  className,
  children,
  ...rest
}: Props) {
  const cls = [styles.chip, styles[size], styles[tone], className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
