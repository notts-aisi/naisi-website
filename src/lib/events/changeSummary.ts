/**
 * Shared shape for a notify-worthy event change, plus the date formatter the
 * change-summary and broadcast emails both use. One change renders as
 * struck-through old, clear new in the EventChangeSummary email block.
 */
import { formatSiteDate, isSameSiteDay } from "@/lib/datetime/siteTime";

/** One notify-worthy field change, human-readable. */
export type EventChange = {
  /** Field label shown to the recipient, e.g. "When" or "Where". */
  label: string;
  /** The value as the recipient last knew it. */
  from: string;
  /** The new value. */
  to: string;
};

/**
 * Human-readable event date/time line, e.g. "Fri 6 June 2026, 18:00 → 21:00".
 * A same-day end collapses to just the end time; a different-day end spells
 * out the full date.
 *
 * In London civil time through `siteTime`, never the process default: every
 * caller but the editor is a route or a scheduler job, and a container's zone
 * is UTC, which put every emailed time an hour early through the summer.
 */
export function formatEventWhen(
  startAt: Date | null,
  endAt: Date | null,
): string {
  if (!startAt) return "Date to be confirmed";
  const base = formatSiteDate(startAt, {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (!endAt) return base;
  if (isSameSiteDay(startAt, endAt)) {
    const endTime = formatSiteDate(endAt, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${base} → ${endTime}`;
  }
  return `${base} → ${formatSiteDate(endAt, {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** Parse an unknown payload into a clean EventChange[] (strings only, capped). */
export function parseEventChanges(raw: unknown): EventChange[] {
  if (!Array.isArray(raw)) return [];
  const out: EventChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (
      typeof c.label === "string" &&
      typeof c.from === "string" &&
      typeof c.to === "string"
    ) {
      out.push({
        label: c.label.slice(0, 60),
        from: c.from.slice(0, 200),
        to: c.to.slice(0, 200),
      });
    }
  }
  return out.slice(0, 10);
}
