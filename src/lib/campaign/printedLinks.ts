/**
 * The short links that are already on paper.
 *
 * Each of these is `naisi.uk/q/<slug>`, encoded in a QR code that has been
 * printed and handed out. Paper cannot be edited, so a slug in this list is
 * permanent: it is never removed, never renamed and never given to anything
 * else. `tests/scan-counting.test.mjs` holds the list in place and fails on a
 * change to any entry that is already here. Adding a new one is fine.
 *
 * What each code DOES is not decided here. The redirects in `next.config.ts`
 * answer the scan, and they are deliberately left alone by everything in this
 * directory. This list only says which slugs are real, so the scan counter
 * can tell a code somebody printed from a string somebody typed.
 */

export type PrintedLink = {
  slug: string;
  /** What it is printed on, for whoever reads this file or a test failure. */
  label: string;
};

export const PRINTED_LINKS: readonly PrintedLink[] = Object.freeze([
  { slug: "movie", label: "Freshers' movie screening poster" },
  { slug: "brochure", label: "Freshers' fair brochure" },
  { slug: "poster", label: "General society poster" },
  { slug: "join", label: "The get involved code" },
  { slug: "ig", label: "Instagram code" },
]);

const PRINTED_SLUGS: ReadonlySet<string> = new Set(PRINTED_LINKS.map((link) => link.slug));

/** True for a slug that exists on printed material. */
export function isPrintedSlug(slug: string): boolean {
  return PRINTED_SLUGS.has(slug);
}
