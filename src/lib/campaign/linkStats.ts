/**
 * The numbers behind the /admin/links dashboard, worked out from two reads:
 * the per-day scan counters and the subscriptions a short link produced.
 *
 * Pure: no database, no React, no clock. The component does the reads and
 * hands the rows here, so the arithmetic can be tested without either.
 *
 * TWO SIGN-UP NUMBERS, NEVER ONE. A public sign-up is double opt-in: somebody
 * who types their address at the stall is not subscribed until they open an
 * email and press a button, often that evening on another device. "Started"
 * counts everyone who submitted the form; "confirmed" counts those who then
 * confirmed. One number would flatter the print run by however many people
 * never opened the mail.
 *
 * PEOPLE, NOT ROWS. A subscription is one row per address per channel, so
 * somebody who ticks both the newsletter and events makes two rows from one
 * form. Counting rows would count that person twice, so both numbers count
 * distinct addresses. The addresses themselves never leave this function:
 * what comes out is counts.
 */
import { isCampaignSlug } from "./attribution";

export type ScanDay = {
  slug: string;
  /** `YYYY-MM-DD`, a London calendar day. */
  date: string;
  count: number;
  /** `00` to `23`, London hours. */
  hours: Record<string, number>;
};

export type AttributedSignup = {
  email: string;
  /** `qr:<slug>` or `qr:<slug>:<interest>`. */
  source: string;
  confirmed: boolean;
  /** The London day the row was created on, or null if it carries no date. */
  createdOn: string | null;
};

export type LinkStats = {
  scans: number;
  signupsStarted: number;
  signupsConfirmed: number;
  /** Oldest first. Only days with at least one scan. */
  byDay: { date: string; count: number }[];
  /** Summed over the range, for "which hour of the fair was busiest". */
  byHour: Record<string, number>;
};

export const EMPTY_LINK_STATS: LinkStats = {
  scans: 0,
  signupsStarted: 0,
  signupsConfirmed: 0,
  byDay: [],
  byHour: {},
};

/** The slug a subscription's `source` names, or null when it names none. */
export function slugFromSource(source: string): string | null {
  const [prefix, slug] = source.split(":");
  if (prefix !== "qr" || !slug) return null;
  return isCampaignSlug(slug) ? slug : null;
}

/**
 * Move a `YYYY-MM-DD` key by whole days. Done on the calendar, at midday UTC,
 * so a clock change can never land the answer on the wrong day.
 */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Per-slug numbers for a range. `fromDate` is inclusive; null means all time.
 * A slug appears in the result if it was scanned or produced a sign-up, even
 * when no link by that name exists any more, so nothing counted is dropped.
 */
export function buildLinkStats(args: {
  days: ScanDay[];
  signups: AttributedSignup[];
  fromDate: string | null;
}): Map<string, LinkStats> {
  const { days, signups, fromDate } = args;
  const out = new Map<string, LinkStats>();
  const statsFor = (slug: string): LinkStats => {
    let stats = out.get(slug);
    if (!stats) {
      stats = { scans: 0, signupsStarted: 0, signupsConfirmed: 0, byDay: [], byHour: {} };
      out.set(slug, stats);
    }
    return stats;
  };

  for (const day of days) {
    if (fromDate && day.date < fromDate) continue;
    if (day.count <= 0) continue;
    const stats = statsFor(day.slug);
    stats.scans += day.count;
    stats.byDay.push({ date: day.date, count: day.count });
    for (const [hour, n] of Object.entries(day.hours)) {
      if (n > 0) stats.byHour[hour] = (stats.byHour[hour] ?? 0) + n;
    }
  }
  for (const stats of out.values()) stats.byDay.sort((a, b) => a.date.localeCompare(b.date));

  const started = new Map<string, Set<string>>();
  const confirmed = new Map<string, Set<string>>();
  for (const signup of signups) {
    const slug = slugFromSource(signup.source);
    if (!slug) continue;
    // A row with no date cannot be placed in a range, so it only counts when
    // the range is all time.
    if (fromDate && (!signup.createdOn || signup.createdOn < fromDate)) continue;
    const who = signup.email.trim().toLowerCase();
    if (!who) continue;
    if (!started.has(slug)) started.set(slug, new Set());
    started.get(slug)!.add(who);
    if (signup.confirmed) {
      if (!confirmed.has(slug)) confirmed.set(slug, new Set());
      confirmed.get(slug)!.add(who);
    }
  }
  for (const [slug, who] of started) statsFor(slug).signupsStarted = who.size;
  for (const [slug, who] of confirmed) statsFor(slug).signupsConfirmed = who.size;

  return out;
}

/** Add several links' numbers together, for a campaign or a kind. */
export function sumLinkStats(all: LinkStats[]): Pick<LinkStats, "scans" | "signupsStarted" | "signupsConfirmed"> {
  return all.reduce(
    (total, stats) => ({
      scans: total.scans + stats.scans,
      signupsStarted: total.signupsStarted + stats.signupsStarted,
      signupsConfirmed: total.signupsConfirmed + stats.signupsConfirmed,
    }),
    { scans: 0, signupsStarted: 0, signupsConfirmed: 0 },
  );
}

// ---------------------------------------------------------------------------
// Series for the two small charts
// ---------------------------------------------------------------------------

export type StatColumn = { key: string; tick: string; name: string; value: number };

// A date key is a calendar day, not an instant, so it is formatted at midday
// UTC in UTC: no zone can then move it onto the day before or after.
const DAY_NAME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

function dayName(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return DAY_NAME.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** The most columns the by-day chart draws. Past this it shows the latest. */
export const MAX_DAY_COLUMNS = 30;

/**
 * One column per day from `fromDate` (or the first scan) to `today`, zeros
 * included. A day nobody scanned is part of the story, and leaving it out
 * would put two busy days side by side that were a week apart.
 */
export function dayColumns(
  byDay: LinkStats["byDay"],
  fromDate: string | null,
  today: string,
): StatColumn[] {
  if (byDay.length === 0) return [];
  const counts = new Map(byDay.map((d) => [d.date, d.count]));
  let start = fromDate ?? byDay[0].date;
  const earliest = shiftDateKey(today, -(MAX_DAY_COLUMNS - 1));
  if (start < earliest) start = earliest;
  const out: StatColumn[] = [];
  for (let key = start; key <= today; key = shiftDateKey(key, 1)) {
    out.push({ key, tick: String(Number(key.slice(8))), name: dayName(key), value: counts.get(key) ?? 0 });
  }
  return out;
}

/** One column per London hour, from the first busy hour to the last. */
export function hourColumns(byHour: LinkStats["byHour"]): StatColumn[] {
  const busy = Object.entries(byHour)
    .filter(([, n]) => n > 0)
    .map(([hour]) => Number(hour))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  if (busy.length === 0) return [];
  const out: StatColumn[] = [];
  for (let hour = Math.min(...busy); hour <= Math.max(...busy); hour += 1) {
    const key = String(hour).padStart(2, "0");
    const next = String((hour + 1) % 24).padStart(2, "0");
    out.push({ key, tick: key, name: `${key}:00 to ${next}:00`, value: byHour[key] ?? 0 });
  }
  return out;
}
