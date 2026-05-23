/**
 * Pull-quotes from past fellows, rendered inside the Fellowships tier.
 *
 * Dev-only by default — the FellowQuotes component is gated on
 * NEXT_PUBLIC_HOMEPAGE_PREVIEW_SECTIONS === "true". Set on the dev backend's
 * App Hosting env vars when ready to preview; flip to prod once the content
 * is final.
 */
export type FellowQuote = {
  /** The quote itself. Keep short — 1-2 sentences. */
  quote: string;
  /** Attribution line — "Name, cohort/role". */
  attribution: string;
};

export const FELLOW_QUOTES: FellowQuote[] = [
  // Seed entries once collected. Component hides when empty.
];
