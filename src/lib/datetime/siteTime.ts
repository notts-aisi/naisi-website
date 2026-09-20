/**
 * Dates and times as the site states them: London civil time, UK format.
 *
 * ## Why this file exists
 *
 * `date.toLocaleString(undefined, …)` formats in the zone and the locale of
 * whatever process runs it. In a browser that is the reader. On the server it
 * is the container, and a Cloud Run container is UTC and en-US, so every event
 * time rendered by a Server Component or written into an email read one hour
 * early for the whole of British Summer Time, in American date order with
 * AM/PM (the public list printed "Thu, May 28 at 04:30 PM"). It was invisible
 * in development, because a laptop in Nottingham has the right defaults, and
 * it reached the public events list, the event page, the home page, the RSVP
 * emails, the change notices and the announcement.
 *
 * An event, a deadline or a publication date here is a statement about a room
 * in Nottingham, so it is formatted in one zone for every reader, the way the
 * courses tree already does with `COURSE_TZ`. Anything that runs on the server
 * and formats an instant goes through this module; `tests/server-date-formatting.test.mjs`
 * walks the tree for a formatter that does not name its zone.
 *
 * No `server-only` import: the event editor reaches this through
 * `changeSummary.ts`, and the answer is the same in a browser on purpose.
 */

/** The zone every stated time on the site is in. Same value as `COURSE_TZ`. */
export const SITE_TIMEZONE = "Europe/London";

/** Day before month, 24-hour clock. */
export const SITE_LOCALE = "en-GB";

/** The parts a caller may ask for. The zone and the clock are not negotiable. */
export type SiteDateFields = Pick<
  Intl.DateTimeFormatOptions,
  "weekday" | "day" | "month" | "year" | "hour" | "minute"
>;

/**
 * Format an instant in London civil time, UK style.
 *
 * `hourCycle: "h23"` rather than the locale default so midnight is 00:00 and
 * never 24:00, and so no runtime falls back to a 12-hour clock.
 */
export function formatSiteDate(date: Date, fields: SiteDateFields): string {
  return new Intl.DateTimeFormat(SITE_LOCALE, {
    ...fields,
    timeZone: SITE_TIMEZONE,
    hourCycle: "h23",
  }).format(date);
}

const DAY_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: SITE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Whether two instants fall on the same London calendar day.
 *
 * Compared as civil dates, not with `getDate()`: those read the process zone,
 * so on the server an event running 23:30 to 00:30 in London (22:30 to 23:30
 * UTC in summer) counted as one day and lost the date from its end time.
 */
export function isSameSiteDay(a: Date, b: Date): boolean {
  return DAY_KEY_FORMAT.format(a) === DAY_KEY_FORMAT.format(b);
}
