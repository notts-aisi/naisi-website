/*
 * Canonical breakpoints for the NAISI site.
 *
 * CSS custom properties cannot be used inside `@media` conditions, so these
 * values are mirrored as a comment block at the top of tokens.css and used
 * as literal `Xrem` values in CSS modules. This file is the source of truth
 * for JavaScript-side `matchMedia` calls.
 *
 * See docs/mobile-conventions.md for the convention and the rationale for
 * NOT using a PostCSS custom-media plugin.
 */

export const BREAKPOINTS = {
  /** small phone landscape / large phone portrait — 576px */
  sm: 36,
  /** phone ↔ tablet split — 768px. Most-used breakpoint in the codebase. */
  md: 48,
  /** tablet ↔ laptop split — 960px. Sidebar collapse, hero emblem cutover. */
  lg: 60,
  /** wide-laptop — 1280px. Reserved for wide-data views. */
  xl: 80,
} as const;

export type BreakpointKey = keyof typeof BREAKPOINTS;

/** Build a `(max-width: …rem)` media query string for matchMedia. */
export function maxWidth(key: BreakpointKey): string {
  return `(max-width: ${BREAKPOINTS[key]}rem)`;
}

/** Build a `(min-width: …rem)` media query string for matchMedia. */
export function minWidth(key: BreakpointKey): string {
  return `(min-width: ${BREAKPOINTS[key]}rem)`;
}
