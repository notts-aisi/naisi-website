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

export type SocialLink = { label: string; href: string };

export const SOCIAL_LINKS: SocialLink[] = [
  { label: "Substack", href: "https://nottsaisafety.substack.com" },
  { label: "Instagram", href: "https://www.instagram.com/notts.ai.safety/" },
  { label: "Linktree", href: "https://linktr.ee/nottsaisi" },
  { label: "SU page", href: SU_PAGE_URL },
];
