/**
 * Which day and which hour a scan is counted under.
 *
 * Both are read in London, never in UTC and never in the server's own zone.
 * The people reading these numbers stood at the stall: if the queue peaked at
 * eleven, the chart has to say eleven, and through British Summer Time a UTC
 * bucket would say ten. The day rolls over at London midnight for the same
 * reason. The server runs in UTC, so a formatter that names no zone would be
 * wrong all summer without anything failing.
 */
import { SITE_TIMEZONE } from "@/lib/datetime/siteTime";

// `hourCycle: "h23"` rather than `hour12: false`: the latter prints midnight
// as "24" on some ICU builds, which would make a twenty-fifth bucket.
const LONDON_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: SITE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export type ScanBucket = {
  /** `YYYY-MM-DD`, the London calendar day. */
  date: string;
  /** `00` to `23`, the London hour. */
  hour: string;
};

export function scanBucket(at: Date): ScanBucket {
  const parts: Record<string, string> = {};
  for (const part of LONDON_PARTS.formatToParts(at)) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour };
}

/**
 * One document per code per London day. The double underscore is the
 * repository's separator for a composed document id, and a slug can never
 * contain an underscore, so the two halves cannot run together.
 */
export function scanDayDocId(slug: string, date: string): string {
  return `${slug}__${date}`;
}
