/**
 * The rows on /links, our own page of "every link in one place".
 *
 * This is the page a QR code on printed material lands on, and the one the
 * Instagram bio can point at. It replaces the third-party link page: the
 * addresses below are ours to change with a pull request, the page renders
 * without JavaScript for somebody on fair-day signal, and a sign-up made from
 * it records which flyer brought the person (see `lib/campaign/attribution`).
 *
 * A module rather than JSON for the same reason as `socials.ts`: a row built
 * from `SU_PAGE_URL` is checked at build time rather than matched by label.
 * The mailing list form, the application buttons and the upcoming events are
 * not rows here. They are rendered by the page itself, because each is more
 * than a link.
 */
import { SU_PAGE_URL, socialHref } from "./socials";

export type LinkRow = {
  /** Stable key, also the React key. */
  key: string;
  label: string;
  /** One plain line under the label. Says what is on the other side. */
  sub: string;
  href: string;
  /**
   * Announced but not available yet. The row is shown with an "Opens soon"
   * marker and is NOT a link, so nobody taps through to a page that is not
   * there. Remove the flag when it opens; the `href` is already in place.
   */
  soon?: boolean;
};

export type LinkGroup = {
  heading: string;
  rows: LinkRow[];
};

export const LINK_GROUPS: LinkGroup[] = [
  {
    heading: "Get involved",
    rows: [
      {
        key: "courses",
        label: "Our courses",
        sub: "Termly AI safety courses. See what is running and apply.",
        href: "/courses",
      },
      {
        key: "events",
        label: "All events",
        sub: "Socials, talks and fellowship sessions. No account needed to look.",
        href: "/events",
      },
      {
        key: "register",
        label: "Create a NAISI account",
        sub: "Sign up with your university email to apply for courses.",
        href: "/register",
      },
      {
        key: "su",
        label: "Join the society for £6",
        sub: "Official Students' Union membership, on the SU website.",
        href: SU_PAGE_URL,
      },
    ],
  },
  {
    heading: "Find us",
    rows: [
      {
        key: "instagram",
        label: "Instagram",
        sub: "@notts.ai.safety",
        href: socialHref("Instagram"),
      },
      {
        key: "substack",
        label: "Substack",
        sub: "Longer writing from the committee, and past newsletters.",
        href: socialHref("Substack"),
      },
      // Hidden for now (21 Sep 2026): /resources redirects home until the
      // page is rewritten, and a row pointing at it would bounce people back
      // to where they started. See the /resources entry in next.config.ts.
      // {
      //   key: "resources",
      //   label: "Resources and reading lists",
      //   sub: "Where to start reading about AI safety.",
      //   href: "/resources",
      // },
      {
        key: "home",
        label: "naisi.uk",
        sub: "Everything else about who we are and what we do.",
        href: "/",
      },
    ],
  },
];

/** A row that leaves the site opens in a new tab and says so to assistive tech. */
export function isOffsite(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
