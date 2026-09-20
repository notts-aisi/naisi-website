/**
 * Minimal iCalendar (RFC 5545) builder. Emits one VEVENT inside a VCALENDAR
 * with every timestamp in UTC ("Z" form) so any calendar client resolves it
 * correctly without needing a VTIMEZONE block. Shared by the public
 * `calendar.ics` download route and the RSVP-approval email attachment.
 *
 * Beside it live the "open this in a web calendar" link builders: Google, and
 * the two Outlook hosts. Those carry the event in a query string rather than
 * in a file, which is the only path that survives an in-app browser (Instagram
 * and Facebook block the file download on iOS), so a page that offers a
 * calendar entry offers both shapes.
 */

type IcsArgs = {
  /** Stable unique id for the event (the Firestore doc id works). */
  uid: string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  startAt: Date;
  /** Defaults to startAt + 2h when omitted. */
  endAt?: Date | null;
  /**
   * When the organiser last touched the event. Becomes LAST-MODIFIED and the
   * SEQUENCE counter: same UID plus a higher SEQUENCE is how a client knows a
   * re-downloaded file REPLACES the entry somebody already added rather than
   * sitting beside it. A poster is printed once and the details change after
   * it, so this is the property that decides whether a correction lands.
   */
  updatedAt?: Date | null;
};

/** The fields both web-calendar link builders take. */
type CalendarLinkArgs = {
  title: string;
  description?: string;
  location?: string;
  startAt: Date;
  endAt?: Date | null;
};

/** Escape a value for an iCalendar text field (RFC 5545 section 3.3.11). */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Format a Date as a UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ. */
function formatUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Format a Date as YYYY-MM-DDTHH:MM:SSZ, the form Outlook's deep link takes. */
function formatIsoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/** The end an event really has: the stored one, or two hours after the start. */
function endFor(args: { startAt: Date; endAt?: Date | null }): Date {
  return args.endAt && args.endAt.getTime() > args.startAt.getTime()
    ? args.endAt
    : new Date(args.startAt.getTime() + DEFAULT_DURATION_MS);
}

/**
 * SEQUENCE counts SECONDS SINCE 2020, not since 1970.
 *
 * RFC 5545 makes SEQUENCE a non-negative integer that may only grow for a
 * given UID, and clients treat it as a signed 32-bit value: epoch
 * milliseconds overflow that immediately, and epoch seconds overflow it in
 * January 2038. Counting from 2020 keeps one-second resolution (finer than an
 * organiser can edit an event twice) with roughly 68 years of headroom.
 *
 * An event with no `updatedAt` scores 0, which is what a file with no SEQUENCE
 * line means anyway, so the fallback loses nothing.
 */
const SEQUENCE_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_SEQUENCE = 2 ** 31 - 1;

export function icsSequenceFor(updatedAt: Date | null | undefined): number {
  const ms = updatedAt?.getTime();
  if (typeof ms !== "number" || !Number.isFinite(ms)) return 0;
  const seconds = Math.floor((ms - SEQUENCE_EPOCH_MS) / 1000);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_SEQUENCE);
}

export function buildEventIcs(args: IcsArgs): string {
  const start = args.startAt;
  const end = endFor(args);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NAISI//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(args.uid)}@naisi.uk`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `SEQUENCE:${icsSequenceFor(args.updatedAt)}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeIcsText(args.title)}`,
  ];
  if (args.updatedAt) lines.push(`LAST-MODIFIED:${formatUtc(args.updatedAt)}`);
  if (args.description) lines.push(`DESCRIPTION:${escapeIcsText(args.description)}`);
  if (args.location) lines.push(`LOCATION:${escapeIcsText(args.location)}`);
  if (args.url) lines.push(`URL:${escapeIcsText(args.url)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 requires CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}

/**
 * Build an "Add to Google Calendar" link (the TEMPLATE render form). Opens
 * Google Calendar with the event pre-filled — one tap, no file download.
 */
export function googleCalendarUrl(args: CalendarLinkArgs): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: args.title,
    dates: `${formatUtc(args.startAt)}/${formatUtc(endFor(args))}`,
  });
  if (args.description) params.set("details", args.description);
  if (args.location) params.set("location", args.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * The two Outlook web hosts, which are not interchangeable: a personal
 * account lives on outlook.live.com and a work or university Microsoft 365
 * account on outlook.office.com, and the wrong host lands the reader on a
 * sign-in page for an account they do not have. Nottingham runs student mail
 * on Microsoft 365, so both are offered rather than one guessed at.
 *
 * The compose path carries NO account index (`/calendar/deeplink/compose`,
 * never `/calendar/0/deeplink/compose`): the index selects the first
 * signed-in account, which means nothing in a stranger's browser.
 *
 * Known, and deliberately not worked around: when the reader is signed out,
 * Microsoft's login redirect turns the escaped spaces in `subject` back into
 * literal plus signs, so the title arrives as "NAISI+Intro+to+AI+Safety". The
 * documented workarounds substitute thin spaces for real ones, which is worse
 * than the symptom. A page offering these keeps them behind a secondary
 * disclosure and leads with Apple and Google instead.
 */
const OUTLOOK_LIVE_BASE = "https://outlook.live.com/calendar/deeplink/compose";
const OUTLOOK_OFFICE_BASE = "https://outlook.office.com/calendar/deeplink/compose";

function outlookUrl(base: string, args: CalendarLinkArgs): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: args.title,
    startdt: formatIsoUtc(args.startAt),
    enddt: formatIsoUtc(endFor(args)),
  });
  if (args.location) params.set("location", args.location);
  // Plain text only: angle brackets cannot be passed through the deep link at
  // all, and the body is rendered as HTML at the far end.
  if (args.description) params.set("body", args.description);
  return `${base}?${params.toString()}`;
}

/** Add to a personal Outlook.com calendar. */
export function outlookLiveUrl(args: CalendarLinkArgs): string {
  return outlookUrl(OUTLOOK_LIVE_BASE, args);
}

/** Add to a Microsoft 365 calendar (a university or work account). */
export function outlookOfficeUrl(args: CalendarLinkArgs): string {
  return outlookUrl(OUTLOOK_OFFICE_BASE, args);
}
