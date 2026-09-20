/**
 * Where NAISI lives off-site, and how to write to us.
 *
 * The SU page URL had four copies before this file existed: the footer's JSON,
 * the landing page's Elsewhere row, the hero CTA and one more inline link on
 * the landing page. The profile's membership badge needed a fifth, which is
 * the point at which a constant stops being tidiness. It is one export now,
 * and everything that points at the society's membership page points here.
 *
 * A module rather than the JSON file it replaces, so a link built from the
 * constant is checked at build time rather than matched by label at runtime.
 */

/**
 * The Students' Union activity page: where somebody actually buys society
 * membership. Site membership and SU membership are separate things, and this
 * is the SU one.
 */
export const SU_PAGE_URL = "https://su.nottingham.ac.uk/activities/view/NottsAISafety";

export const CONTACT_EMAIL = "contact@naisi.org.uk";

/**
 * Our own page of every link in one place, and where most printed QR codes
 * land. It replaced a third-party link page, which is why it is a path on
 * this site and is NOT in `SOCIAL_LINKS` below: that list is the places we
 * live OFF the site, and everything that renders it opens a new tab.
 */
export const LINKS_PAGE_PATH = "/links";

export type SocialLink = { label: string; href: string };

/** Off-site only. Every entry is a full address, opened in a new tab. */
export const SOCIAL_LINKS: SocialLink[] = [
  { label: "Substack", href: "https://nottsaisafety.substack.com" },
  { label: "Instagram", href: "https://www.instagram.com/notts.ai.safety/" },
  { label: "SU page", href: SU_PAGE_URL },
];

/**
 * One social's address, by label. Throws at build time when the label names
 * nothing, so a renamed entry breaks the build and not a link.
 */
export function socialHref(label: string): string {
  const found = SOCIAL_LINKS.find((link) => link.label === label);
  if (!found) throw new Error(`socials.ts: no "${label}" entry in SOCIAL_LINKS`);
  return found.href;
}
