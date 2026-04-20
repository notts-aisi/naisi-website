"use client";

import type { SelectHTMLAttributes } from "react";
import styles from "./Select.module.css";

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  /** Additional classes to append to the default styled look. */
  className?: string;
};

/**
 * Styled replacement for native <select>. Shares visual language with Input —
 * custom chevron, theme-token border/background, no browser default chrome.
 * Use this anywhere you'd reach for <select> on the site.
 */
export default function Select({ className, children, ...rest }: Props) {
  return (
    <select {...rest} className={`${styles.select} ${className ?? ""}`}>
      {children}
    </select>
  );
}
