import type { EventChange } from "./changeSummary";

/**
 * WHAT AN EVENT'S LOCATION SAYS TO A PERSON, decided in one place.
 *
 * An event carries three fields: `location` (the exact room or address),
 * `locationHidden` (the organiser chose to keep it off every public surface)
 * and `locationPublicText` (the fuzzy label shown instead, "somewhere on
 * University Park"). Who may see the exact one is a single rule: a person
 * holding a CONFIRMED place. Everybody else, the public page, the events
 * list, the calendar file, the announcement, an attendee whose RSVP is
 * pending or waitlisted, sees the public label, and when the organiser left
 * that label empty they see a placeholder rather than the exact text.
 *
 * ── WHY ONE MODULE ──────────────────────────────────────────────────────────
 * Until 8 September 2026 that rule was re-derived inline in eight files, and
 * two of them derived it wrong: the RSVP email guarded the redaction on the
 * fuzzy label being NON-EMPTY, so an organiser clearing the label switched the
 * redaction off and every acknowledgement carried the exact address; and the
 * organiser broadcast used the exact text for everybody on the grounds that
 * its audience "already knew it", when the audience included the waitlist.
 * The home page's upcoming list had the first fault too. A rule that lives in
 * one file cannot disagree with itself, and `tests/event-location-disclosure
 * .test.mjs` walks the tree to keep every other file out of the decision.
 *
 * Isomorphic on purpose: no `server-only`, no Firestore import. The public
 * pages render it in a Server Component and the editor's preview in a Client
 * Component, and the emails reach it through server code.
 */

export type EventLocationFields = {
  location?: string | null;
  locationHidden?: boolean | null;
  locationPublicText?: string | null;
};

/** Shown when the exact location is hidden and the organiser gave no label. */
export const LOCATION_WITHHELD = "Exact location shared once your RSVP is confirmed";

/** The public placeholder for a hidden location on a list that has no RSVP relationship. */
export const LOCATION_SHARED_WITH_ATTENDEES = "Location shared with attendees";

/** Shown when the organiser has not entered a location at all. */
export const LOCATION_TO_BE_CONFIRMED = "Location to be confirmed";

/** Explains, to somebody who may see it, why the exact location was hidden. */
export const HIDDEN_LOCATION_DISCLOSURE =
  "This location was kept off the public event page. Please don't share it widely.";

const trimmed = (value: string | null | undefined): string => (value ?? "").trim();

/**
 * Whether an RSVP status entitles its holder to the exact location. Only a
 * confirmed place does: a waitlisted attendee is one cancellation away from a
 * place and has none yet, and a pending one has asked and not been answered.
 */
export function holdsPlace(status: string | null | undefined): boolean {
  return status === "confirmed";
}

/** Whether the organiser is keeping the exact location off public surfaces. */
export function locationWithheld(event: EventLocationFields): boolean {
  return event.locationHidden === true;
}

/**
 * The text a public surface may print, possibly empty, never the exact
 * location of a hidden event. Callers that want a placeholder for the empty
 * case use `publicLocationLine`.
 */
export function publicLocationText(event: EventLocationFields): string {
  return locationWithheld(event) ? trimmed(event.locationPublicText) : trimmed(event.location);
}

/**
 * A full line for a list with no RSVP relationship: the announcement email,
 * the home page. A hidden location with no label says it is shared with
 * attendees; an event with no location at all says so.
 */
export function publicLocationLine(event: EventLocationFields): string {
  const text = publicLocationText(event);
  if (text) return text;
  return locationWithheld(event) ? LOCATION_SHARED_WITH_ATTENDEES : LOCATION_TO_BE_CONFIRMED;
}

/**
 * The line an attendee's message carries, by whether they hold a confirmed
 * place. A holder gets the exact location, with a disclosure note when it was
 * hidden so they know not to pass it on. Everybody else gets the public label
 * with a note that the exact one follows confirmation, or the note alone when
 * the organiser gave no label. The empty-label case is the one that matters:
 * a missing label tightens the redaction rather than switching it off.
 */
export function locationForAttendee(
  event: EventLocationFields,
  { holdsPlace: holder }: { holdsPlace: boolean },
): { line: string; disclosure?: string } {
  const exact = trimmed(event.location);
  if (holder) {
    if (locationWithheld(event) && exact) {
      return { line: exact, disclosure: HIDDEN_LOCATION_DISCLOSURE };
    }
    return { line: exact || LOCATION_TO_BE_CONFIRMED };
  }
  if (locationWithheld(event)) {
    const label = trimmed(event.locationPublicText);
    return { line: label ? `${label}, exact location shared once your RSVP is confirmed` : LOCATION_WITHHELD };
  }
  return { line: exact || LOCATION_TO_BE_CONFIRMED };
}

/**
 * The exact location for a calendar entry, or nothing. A calendar file is a
 * copy of the location that outlives the message it came in, so it carries
 * the exact text only for a confirmed place; the public calendar download
 * uses `publicLocationText` instead.
 */
export function exactLocationFor(
  event: EventLocationFields,
  { holdsPlace: holder }: { holdsPlace: boolean },
): string | undefined {
  if (!holder) return undefined;
  return trimmed(event.location) || undefined;
}

/**
 * A change summary as an attendee may see it. The "Where" line of a change
 * notice carries the exact old and new location, so for a recipient who does
 * not hold a place at a hidden-location event it is replaced by the public
 * line. Two tests pick the entry out: its label, which is what the update
 * route writes, and its content, so an entry under any other label that
 * quotes the exact text is redacted too.
 */
export function changesForAttendee(
  changes: EventChange[],
  event: EventLocationFields,
  { holdsPlace: holder }: { holdsPlace: boolean },
): EventChange[] {
  if (holder || !locationWithheld(event)) return changes;
  const exact = trimmed(event.location).toLowerCase();
  const quotesExact = (text: string) => exact !== "" && text.toLowerCase().includes(exact);
  const { line } = locationForAttendee(event, { holdsPlace: false });
  return changes.map((change) =>
    change.label.trim().toLowerCase() === "where" || quotesExact(change.from) || quotesExact(change.to)
      ? { label: change.label, from: "the previous location", to: line }
      : change,
  );
}
