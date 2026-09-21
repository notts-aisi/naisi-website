/**
 * Whether an event's date or time changed between somebody signing up and
 * their place being confirmed, and what to tell them if it did.
 *
 * COMPARES INSTANTS, NEVER WORDS. The first version compared the formatted
 * line stored at signup ("Thu 24 September 2026, 18:00") with a freshly
 * formatted one. Two strings differ whenever the FORMATTER changes, and it
 * did: on 20 September 2026 every emailed time moved from the server's zone to
 * London time, so anybody who had signed up before that and was approved after
 * it was told "This changed since you signed up", with the old, wrong time
 * shown against the right one, for an event nobody had touched. A snapshot now
 * records the instants as well, and those are what is compared.
 *
 * Snapshots written before that change hold only the words. For those, the
 * event's own `updatedAt` settles the common case: if the organiser has not
 * edited the event since the person signed up, the schedule cannot have
 * changed, whatever two strings say. (RSVP counters do not bump `updatedAt`;
 * only an organiser's edit does.) When it HAS been edited since, the words are
 * all there is, so they are compared, as before. That residue shrinks to
 * nothing as old sign-ups are decided.
 *
 * Pure: no database and no clock, so every branch is tested.
 */
import { formatEventWhen, type EventChange } from "./changeSummary";

export type ScheduleSnapshot = {
  /** The line shown at signup. Kept for display, and for old snapshots. */
  scheduleLabel: string;
  /** ISO instant, null for an undated event, undefined on an old snapshot. */
  startAtIso?: string | null;
  endAtIso?: string | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The instants to store on a new snapshot, beside the label. */
export function scheduleInstants(startAt: Date | null, endAt: Date | null) {
  return { startAtIso: iso(startAt), endAtIso: iso(endAt) };
}

export function scheduleChangeSinceSignup(args: {
  snapshot: ScheduleSnapshot;
  liveStartAt: Date | null;
  liveEndAt: Date | null;
  /** When the organiser last edited the event, if known. */
  eventUpdatedAt: Date | null;
  /** When this person signed up, if known. */
  signedUpAt: Date | null;
}): EventChange | null {
  const { snapshot, liveStartAt, liveEndAt, eventUpdatedAt, signedUpAt } = args;
  const liveLabel = formatEventWhen(liveStartAt, liveEndAt);

  if (snapshot.startAtIso !== undefined) {
    const same = snapshot.startAtIso === iso(liveStartAt) && (snapshot.endAtIso ?? null) === iso(liveEndAt);
    if (same) return null;
    // Both sides through today's formatter, so the two lines differ only where
    // the event does, and never in style.
    const from = formatEventWhen(
      snapshot.startAtIso ? new Date(snapshot.startAtIso) : null,
      snapshot.endAtIso ? new Date(snapshot.endAtIso) : null,
    );
    return { label: "When", from, to: liveLabel };
  }

  // An old snapshot: words only.
  if (eventUpdatedAt && signedUpAt && eventUpdatedAt.getTime() <= signedUpAt.getTime()) return null;
  if (snapshot.scheduleLabel === liveLabel) return null;
  return { label: "When", from: snapshot.scheduleLabel, to: liveLabel };
}
