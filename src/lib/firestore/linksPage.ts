/**
 * `linksPage/main`: what the /links page says, editable from the admin console.
 *
 * /links is the page most printed QR codes land on, so two things matter more
 * than they would anywhere else:
 *
 *  - IT NEVER RENDERS EMPTY. The rows in `src/content/links.ts` are the
 *    built-in page. They are what is shown until somebody saves an edit, and
 *    what is shown again if the stored document is missing, unreadable or
 *    does not make sense. An admin cannot break the page by editing it, and
 *    neither can a bad afternoon at Firestore.
 *  - WHAT IS STORED IS NOT TRUSTED JUST BECAUSE IT IS STORED. Every address
 *    goes through `parseDestination()`, the validator the short links use, on
 *    save and again on every read. A row whose address fails it is dropped
 *    from the public page, so a value typed into the Firestore console by hand
 *    never becomes an anchor on a page strangers open.
 *
 * No `server-only` marker: the editor and the public fetcher both import this.
 */
import { LINK_INTERESTS, type LinkInterest } from "@/lib/campaign/attribution";
import { LINK_GROUPS } from "@/content/links";
import { parseDestination } from "./trackedLinks";

export const LINKS_PAGE_LIMITS = {
  groups: 8,
  rowsPerGroup: 20,
  heading: 60,
  label: 80,
  sub: 160,
  href: 500,
} as const;

export type LinksPageRow = {
  id: string;
  label: string;
  /** One plain line under the label. Says what is on the other side. */
  sub: string;
  href: string;
  /** Announced but not available yet: shown with "Opens soon", and not a link. */
  soon: boolean;
  /** Kept in the editor, left off the page. */
  hidden: boolean;
};

export type LinksPageGroup = { id: string; heading: string; rows: LinksPageRow[] };

/**
 * One of the three application buttons. Closed, it leads to the mailing list
 * form and records which one the person was waiting for. Open, it is a link.
 */
export type LinksPageApplication = { open: boolean; href: string };

export type LinksPageContent = {
  applications: Record<LinkInterest, LinksPageApplication>;
  groups: LinksPageGroup[];
};

/** The built-in page: `content/links.ts`, with every application still closed. */
export function defaultLinksPage(): LinksPageContent {
  return {
    applications: Object.fromEntries(
      LINK_INTERESTS.map((id) => [id, { open: false, href: "" }]),
    ) as Record<LinkInterest, LinksPageApplication>,
    groups: LINK_GROUPS.map((group, g) => ({
      id: `group-${g + 1}`,
      heading: group.heading,
      rows: group.rows.map((row) => ({
        id: row.key,
        label: row.label,
        sub: row.sub,
        href: row.href,
        soon: row.soon === true,
        hidden: false,
      })),
    })),
  };
}

type Raw = Record<string, unknown>;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A short id for a new row or group. Only has to be unique within one page. */
export function newLinksPageId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Why an address cannot be used, or null when it can. Empty is allowed when `optional`. */
export function linksPageHrefError(href: string, optional: boolean): string | null {
  if (!href.trim()) return optional ? null : "Say where this row goes.";
  const parsed = parseDestination(href);
  return parsed.ok ? null : parsed.error;
}

/**
 * The stored document as the editor sees it, or null when it is not a links
 * page at all (missing, or damaged past reading), in which case the caller
 * shows the built-in page.
 *
 * Tolerant row by row: one bad row is cleaned up, not a reason to lose the
 * rest. Nothing is dropped here for having a bad address, because the editor
 * has to be able to show that row in order for somebody to fix it.
 */
export function normalizeLinksPage(data: Raw | undefined | null): LinksPageContent | null {
  if (!data || !Array.isArray(data.groups)) return null;
  const seen = new Set<string>();
  const uniqueId = (v: unknown, prefix: string): string => {
    let id = str(v, 40) || newLinksPageId(prefix);
    while (seen.has(id)) id = newLinksPageId(prefix);
    seen.add(id);
    return id;
  };

  const groups: LinksPageGroup[] = [];
  for (const rawGroup of data.groups.slice(0, LINKS_PAGE_LIMITS.groups)) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const g = rawGroup as Raw;
    const rows: LinksPageRow[] = [];
    for (const rawRow of (Array.isArray(g.rows) ? g.rows : []).slice(0, LINKS_PAGE_LIMITS.rowsPerGroup)) {
      if (!rawRow || typeof rawRow !== "object") continue;
      const r = rawRow as Raw;
      const label = str(r.label, LINKS_PAGE_LIMITS.label);
      if (!label) continue;
      rows.push({
        id: uniqueId(r.id, "row"),
        label,
        sub: str(r.sub, LINKS_PAGE_LIMITS.sub),
        href: str(r.href, LINKS_PAGE_LIMITS.href),
        soon: r.soon === true,
        hidden: r.hidden === true,
      });
    }
    groups.push({ id: uniqueId(g.id, "group"), heading: str(g.heading, LINKS_PAGE_LIMITS.heading), rows });
  }

  const rawApplications = (data.applications && typeof data.applications === "object" ? data.applications : {}) as Raw;
  const applications = Object.fromEntries(
    LINK_INTERESTS.map((id) => {
      const a = (rawApplications[id] && typeof rawApplications[id] === "object" ? rawApplications[id] : {}) as Raw;
      return [id, { open: a.open === true, href: str(a.href, LINKS_PAGE_LIMITS.href) }];
    }),
  ) as Record<LinkInterest, LinksPageApplication>;

  return { applications, groups };
}

/**
 * What the public page may render: hidden rows gone, every address validated,
 * empty groups gone. An application only counts as open when its address
 * passes, so "open" with nowhere to go falls back to the mailing list form
 * rather than rendering a dead button.
 */
export function publicLinksPage(content: LinksPageContent): LinksPageContent {
  const groups = content.groups
    .map((group) => ({
      ...group,
      rows: group.rows
        .filter((row) => !row.hidden)
        .filter((row) => (row.soon ? true : linksPageHrefError(row.href, false) === null))
        .map((row) => {
          const parsed = parseDestination(row.href);
          return { ...row, href: parsed.ok ? parsed.value : "" };
        }),
    }))
    .filter((group) => group.rows.length > 0);

  const applications = Object.fromEntries(
    LINK_INTERESTS.map((id) => {
      const a = content.applications[id];
      const parsed = a.open ? parseDestination(a.href) : null;
      return [id, parsed && parsed.ok ? { open: true, href: parsed.value } : { open: false, href: "" }];
    }),
  ) as Record<LinkInterest, LinksPageApplication>;

  return { applications, groups };
}

/** Every reason the editor should refuse to save, in the order they appear. */
export function linksPageErrors(content: LinksPageContent): string[] {
  const errors: string[] = [];
  for (const id of LINK_INTERESTS) {
    const a = content.applications[id];
    if (!a.open) continue;
    const problem = linksPageHrefError(a.href, false);
    if (problem) errors.push(`The ${id} application is marked open: ${problem}`);
  }
  for (const group of content.groups) {
    if (!group.heading.trim()) errors.push("Every section needs a heading.");
    for (const row of group.rows) {
      if (!row.label.trim()) errors.push(`A row in "${group.heading || "a section"}" has no label.`);
      // A row that only says "Opens soon" is text, so it may have no address yet.
      const problem = linksPageHrefError(row.href, row.soon);
      if (problem) errors.push(`"${row.label || "A row"}": ${problem}`);
    }
  }
  return errors;
}
