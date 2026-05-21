/**
 * Minimal iCalendar (RFC 5545) builder. Emits one VEVENT inside a VCALENDAR
 * with every timestamp in UTC ("Z" form) so any calendar client resolves it
 * correctly without needing a VTIMEZONE block. Shared by the public
 * `calendar.ics` download route and the RSVP-approval email attachment.
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

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export function buildEventIcs(args: IcsArgs): string {
  const start = args.startAt;
  const end =
    args.endAt && args.endAt.getTime() > start.getTime()
      ? args.endAt
      : new Date(start.getTime() + DEFAULT_DURATION_MS);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NAISI//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(args.uid)}@naisi.uk`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeIcsText(args.title)}`,
  ];
  if (args.description) lines.push(`DESCRIPTION:${escapeIcsText(args.description)}`);
  if (args.location) lines.push(`LOCATION:${escapeIcsText(args.location)}`);
  if (args.url) lines.push(`URL:${escapeIcsText(args.url)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 requires CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
