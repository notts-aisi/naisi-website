/**
 * `trackedLinks/{slug}`: one short link, `naisi.uk/q/<slug>`, and where it goes.
 *
 * A QR code on a poster and a link in an Instagram bio are the same object
 * with a different `type`: a slug that is ours, pointing at a destination
 * that can be changed after the slug is already out in the world.
 *
 *  - THE SLUG is the document id and the thing that is printed, so it is
 *    chosen once and never changes. There is no rename, and the rules allow no
 *    delete: a code is switched off with `active`, never removed, because the
 *    paper it is on cannot be recalled.
 *  - THE DESTINATION is validated here, by one function, used by the admin
 *    form on save and again by the route on every scan. A stored value is
 *    never trusted just because it is stored: a row typed into the Firestore
 *    console by hand meets the same check. `naisi.uk/q/...` must never become
 *    a way to bounce somebody to an arbitrary site under a university
 *    society's name, so nothing here reads a destination from the request.
 *  - A CAMPAIGN is a label on the link, not a document of its own. A campaign
 *    exists when a link names it.
 *
 * No `server-only` marker: the admin console and the route both import this.
 */
import { isCampaignSlug } from "@/lib/campaign/attribution";

export type TrackedLinkType = "qr" | "link";

export const TRACKED_LINK_TYPES: readonly { value: TrackedLinkType; label: string }[] = [
  { value: "qr", label: "QR code" },
  { value: "link", label: "Link" },
];

export const TRACKED_LINK_LIMITS = {
  slug: 16,
  label: 80,
  campaign: 40,
  destination: 500,
} as const;

export type TrackedLinkDoc = {
  /** The document id and the last segment of the printed address. */
  slug: string;
  /** What it is: "Freshers' fair brochure". Admin-facing only. */
  label: string;
  /** A path on this site (`/links`) or a full `https://` address. */
  destination: string;
  type: TrackedLinkType;
  /** Free text, shared between links to group them. Empty means ungrouped. */
  campaign: string;
  /** Off means the slug lands on /links. The record stays. */
  active: boolean;
  /**
   * Off-site destinations only. On: the visitor passes through a small page on
   * this site that counts the visit and forwards them. Off: a plain redirect,
   * which is not counted. Off by default, because a forward made by a script
   * is not always handed to the destination's app the way a redirect is.
   */
  countOffsite: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  createdByUid: string;
  updatedByUid: string;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  return null;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export function normalizeTrackedLink(id: string, data: Raw): TrackedLinkDoc {
  return {
    slug: id,
    label: str(data.label, TRACKED_LINK_LIMITS.label),
    destination: str(data.destination, TRACKED_LINK_LIMITS.destination),
    type: data.type === "link" ? "link" : "qr",
    campaign: str(data.campaign, TRACKED_LINK_LIMITS.campaign).trim(),
    // Missing reads as ON. A row that lost the field must not switch off a
    // code that is on paper; switching one off is a decision somebody makes.
    active: data.active !== false,
    countOffsite: data.countOffsite === true,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
    createdByUid: str(data.createdByUid, 128),
    updatedByUid: str(data.updatedByUid, 128),
  };
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** Words that would read as part of the site if they were a slug. */
export const RESERVED_SLUGS: readonly string[] = ["q", "links", "api", "admin", "new"];

// Tighter than the grammar the short links ACCEPT (`isCampaignSlug`), which
// has to keep reading anything already printed. A new slug also has to start
// and end on a letter or digit, with single hyphens between.
const MINTABLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a proposed new slug cannot be used, or null when it can. */
export function validateNewSlug(slug: string): string | null {
  if (!slug) return "Give the link a short name.";
  if (slug.length > TRACKED_LINK_LIMITS.slug) {
    return `Keep it to ${TRACKED_LINK_LIMITS.slug} characters. A short address keeps a QR code easy to scan.`;
  }
  if (!MINTABLE_SLUG.test(slug) || !isCampaignSlug(slug)) {
    return "Lowercase letters, numbers and single hyphens only.";
  }
  if (RESERVED_SLUGS.includes(slug)) return `"${slug}" is reserved. Pick another name.`;
  return null;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export type ParsedDestination =
  | { ok: true; kind: "internal"; value: string }
  | { ok: true; kind: "external"; value: string }
  | { ok: false; error: string };

// Parsing a path needs a base. `.invalid` can never be a real host, so an
// input that manages to change the origin is caught by comparing against it.
const PATH_BASE = "https://internal.invalid";

// Control characters, whitespace and backslashes have no business in an
// address, and browsers disagree about what several of them mean.
const UNSAFE_CHARS = /[\u0000-\u0020\u007f\\]/;

/**
 * Decides what a destination is, or why it is refused.
 *
 * `ownOrigins` are origins that count as this site (`https://naisi.uk`), so a
 * full address pasted from the browser is stored as the path it names. Paths
 * are what make a record mean the same thing on the dev site and the live one.
 */
export function parseDestination(
  input: string,
  ownOrigins: readonly string[] = [],
): ParsedDestination {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Say where this link goes." };
  if (raw.length > TRACKED_LINK_LIMITS.destination) {
    return { ok: false, error: "That address is too long." };
  }
  if (UNSAFE_CHARS.test(raw)) {
    return { ok: false, error: "An address cannot contain spaces or backslashes." };
  }

  if (raw.startsWith("/")) {
    // `//host` is another site wearing a path's clothes.
    if (raw.startsWith("//")) {
      return { ok: false, error: "Start a page on this site with a single /." };
    }
    let url: URL;
    try {
      url = new URL(raw, PATH_BASE);
    } catch {
      return { ok: false, error: "That is not a valid page address." };
    }
    if (url.origin !== PATH_BASE) {
      return { ok: false, error: "That is not a page on this site." };
    }
    if (url.pathname === "/q" || url.pathname.startsWith("/q/")) {
      return { ok: false, error: "A short link cannot point at another short link." };
    }
    if (url.pathname.startsWith("/api/")) {
      return { ok: false, error: "That is not a page somebody can open." };
    }
    return { ok: true, kind: "internal", value: `${url.pathname}${url.search}${url.hash}` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      error: "Start with https:// for another site, or with / for a page on this one.",
    };
  }
  // This site, pasted in full: keep the path and drop the rest. First, because
  // it is ours whatever scheme a local server happens to run on. `origin`
  // never includes a name or password, so `https://naisi.uk@elsewhere.example`
  // does not pass for this site here: its origin is elsewhere.example.
  if (ownOrigins.includes(url.origin)) {
    return parseDestination(`${url.pathname}${url.search}${url.hash}`, ownOrigins);
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "Only https:// addresses can be used." };
  }
  // `https://naisi.uk@elsewhere.example` shows as naisi.uk and goes elsewhere.
  if (url.username || url.password) {
    return { ok: false, error: "An address cannot carry a name or password before the site." };
  }
  if (!url.hostname.includes(".")) {
    return { ok: false, error: "That does not look like a website address." };
  }
  return { ok: true, kind: "external", value: url.href };
}

/**
 * The `Location` a scan of `slug` is sent to.
 *
 * A page on this site gets `?q=<slug>` added, which is what the scan counter
 * and the sign-up attribution both read. It is returned as a PATH, never as a
 * full address: the route sends it as a relative `Location`, so nothing here
 * depends on knowing the site's own host (which, behind the hosting proxy, the
 * request does not reliably say).
 */
export function redirectLocation(destination: ParsedDestination & { ok: true }, slug: string): string {
  if (destination.kind === "external") return destination.value;
  const url = new URL(destination.value, PATH_BASE);
  url.searchParams.set("q", slug);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where a slug with no usable record lands: the links page, still carrying the slug. */
export function fallbackLocation(slug: string): string {
  return `/links?q=${encodeURIComponent(slug)}`;
}
