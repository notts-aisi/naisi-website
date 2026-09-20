/**
 * The short links that are already on paper.
 *
 * Each of these is `naisi.uk/q/<slug>`, encoded in a QR code that has been
 * printed and handed out. Paper cannot be edited, so a slug in this list is
 * permanent: it is never removed, never renamed and never given to anything
 * else. `tests/scan-counting.test.mjs` holds the list in place and fails on a
 * change to any entry that is already here. Adding a new one is fine.
 *
 * The list does two jobs, and the second is why it lives in code and not only
 * in the database:
 *
 *  1. IT IS THE SEED. The admin console creates a `trackedLinks` record for
 *     any of these that does not have one yet, so every printed code shows up
 *     there to be repointed like any other link.
 *  2. IT IS THE FLOOR. A scan is answered from the record when there is one.
 *     When there is not (a new environment, a record nobody has created yet)
 *     or the database does not answer in time, the scan is answered from
 *     here. A printed code therefore works even with Firestore down, which no
 *     arrangement that lives only in Firestore could promise.
 *
 * `destination` is where each code went on the day it was printed. Once a
 * record exists the record wins, so repointing a code is done in the console
 * and never by editing this file.
 */
import type { TrackedLinkType } from "@/lib/firestore/trackedLinks";

export type PrintedLink = {
  slug: string;
  /** What it is printed on, for whoever reads this file or a test failure. */
  label: string;
  type: TrackedLinkType;
  campaign: string;
  destination: string;
};

const FRESHERS_2026 = "Freshers 2026";

export const PRINTED_LINKS: readonly PrintedLink[] = Object.freeze([
  {
    slug: "movie",
    label: "Freshers' movie screening poster",
    type: "qr",
    campaign: FRESHERS_2026,
    // The event's add-to-calendar page. The id is the event document's, so
    // editing the event never changes it.
    destination: "/events/W2D1NwTZyNLLYtDQhzGg/calendar",
  },
  {
    slug: "brochure",
    label: "Freshers' fair brochure",
    type: "qr",
    campaign: FRESHERS_2026,
    destination: "/links",
  },
  {
    slug: "poster",
    label: "General society poster",
    type: "qr",
    campaign: FRESHERS_2026,
    destination: "/links",
  },
  {
    slug: "join",
    label: "The get involved code",
    type: "qr",
    campaign: FRESHERS_2026,
    destination: "/links",
  },
  {
    slug: "ig",
    label: "Instagram code",
    type: "qr",
    campaign: FRESHERS_2026,
    destination: "https://www.instagram.com/notts.ai.safety/",
  },
] satisfies PrintedLink[]);

const BY_SLUG: ReadonlyMap<string, PrintedLink> = new Map(
  PRINTED_LINKS.map((link) => [link.slug, link]),
);

/** True for a slug that exists on printed material. */
export function isPrintedSlug(slug: string): boolean {
  return BY_SLUG.has(slug);
}

export function printedLink(slug: string): PrintedLink | null {
  return BY_SLUG.get(slug) ?? null;
}
