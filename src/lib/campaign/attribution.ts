/**
 * Which piece of printed material, and which button, a sign-up came from.
 *
 * A QR code on a flyer encodes `naisi.uk/q/<slug>`, and the redirect in
 * `next.config.ts` lands the scan on a page carrying `?q=<slug>`. Nothing is
 * stored on the visitor's device and nothing is recorded about the scan
 * itself: the marker rides in the URL for one visit, and if that person
 * chooses to join the mailing list it becomes the `source` of the subscription
 * they are knowingly submitting. `source` already exists on every subscription
 * row and the admin Subscriptions table already shows and exports it, so
 * "which flyer worked" is answerable with no new field, no cookie and no
 * change to the privacy policy.
 *
 * The strings this builds:
 *
 *   homepage                 the form on the home page, no code involved
 *   links                    the form on /links, no code involved
 *   links:fellowship         ...after pressing the fellowship button there
 *   qr:flyer                 arrived from the code whose slug is "flyer"
 *   qr:flyer:fellowship      ...and pressed the fellowship button
 *
 * Everything here is client-supplied text, so both parts are held to a closed
 * shape before they are sent. The subscriptions route clamps `source` to 80
 * characters and treats it as a label, never as an authorisation input.
 */

/**
 * A printed slug: lowercase letters, digits and hyphens, sixteen at most.
 * Short on purpose. The whole URL has to stay near 25 characters for the QR
 * code to stay at its lowest density, which is what lets it scan from across
 * a stall.
 */
const CAMPAIGN_SLUG = /^[a-z0-9-]{1,16}$/;

/**
 * What somebody on /links said they are waiting for. A closed list: the value
 * ends up in an admin-facing table, so it is never free text.
 */
export const LINK_INTERESTS = ["fellowship", "facilitator", "incubator"] as const;
export type LinkInterest = (typeof LINK_INTERESTS)[number];

export function isLinkInterest(value: unknown): value is LinkInterest {
  return typeof value === "string" && (LINK_INTERESTS as readonly string[]).includes(value);
}

/**
 * The slug in a location's query string, or null when there is none worth
 * keeping. Lowercased first, because a code somebody retypes by hand arrives
 * as `/q/FLYER` and the redirect passes the segment through as it came.
 */
export function campaignSlugFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("q");
  if (!raw) return null;
  const slug = raw.trim().toLowerCase();
  return CAMPAIGN_SLUG.test(slug) ? slug : null;
}

/**
 * The `source` a subscribe form should send.
 *
 * A code wins over the page the form sits on, because the question the
 * society is asking is which material brought the person here, and the page
 * is implied by where the code points. An interest is appended to either.
 */
export function attributedSource(args: {
  /** The form's own label, e.g. "homepage" or "links". */
  source: string;
  /** `window.location.search` at the moment of submitting. */
  search: string;
  /** Set by the /links buttons; anything outside the closed list is dropped. */
  interest?: string | null;
}): string {
  const slug = campaignSlugFromSearch(args.search);
  const origin = slug ? `qr:${slug}` : args.source;
  return isLinkInterest(args.interest) ? `${origin}:${args.interest}` : origin;
}
