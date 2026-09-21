/**
 * Where a scan of `naisi.uk/q/<slug>` is sent, decided from what the database
 * said about the slug. Pure: no database, no request, no clock. The route does
 * the read and hands the result here, which is what lets every branch be
 * tested, including the ones that only happen when something is broken.
 *
 * The order, and the reason for each step:
 *
 *  1. THE RECORD, when the database produced one. This is the point of the
 *     whole arrangement: a printed code goes wherever the console last said.
 *  2. THE LAST RECORD THIS SERVER SAW, when the database did not answer. A
 *     code that was repointed yesterday should keep going to the new place
 *     through a blip, not snap back to where it went on the day it was printed.
 *  3. THE PRINTED LIST, when there is still nothing. A code that is on paper
 *     works even with the database down.
 *  4. /links, carrying the slug, for everything else. A mistyped or retired
 *     slug never meets a 404, because by the time anybody finds the typo the
 *     print run exists.
 *
 * A record that is switched off lands on /links and stops there: switching a
 * code off is a decision, and the printed list must not quietly undo it. A
 * record whose stored destination does not pass validation is different. That
 * is damage, not a decision, so it falls through to the printed list.
 */
import {
  fallbackLocation,
  parseDestination,
  redirectLocation,
  type TrackedLinkDoc,
} from "@/lib/firestore/trackedLinks";
import { printedLink } from "./printedLinks";

export type TrackedLinkLookup =
  | { state: "found"; link: TrackedLinkDoc }
  | { state: "missing" }
  /** The read failed or timed out. `lastKnown` is this server's last good read, if any. */
  | { state: "unavailable"; lastKnown: TrackedLinkDoc | null };

export type ScanAnswer = {
  /** A path on this site, or a full `https://` address. */
  location: string;
  /** True when the visitor should pass through the counting page first. */
  hop: boolean;
  /** Which step above answered. For tests and for whoever reads a log line. */
  via: "record" | "last-known" | "printed" | "fallback";
};

export function resolveScan(
  slug: string,
  lookup: TrackedLinkLookup,
  ownOrigins: readonly string[] = [],
): ScanAnswer {
  const record =
    lookup.state === "found" ? lookup.link : lookup.state === "unavailable" ? lookup.lastKnown : null;
  const via = lookup.state === "found" ? "record" : "last-known";

  if (record) {
    if (!record.active) return { location: fallbackLocation(slug), hop: false, via };
    const parsed = parseDestination(record.destination, ownOrigins);
    if (parsed.ok) {
      return {
        location: redirectLocation(parsed, slug),
        hop: parsed.kind === "external" && record.countOffsite,
        via,
      };
    }
  }

  const printed = printedLink(slug);
  if (printed) {
    const parsed = parseDestination(printed.destination, ownOrigins);
    if (parsed.ok) return { location: redirectLocation(parsed, slug), hop: false, via: "printed" };
  }

  return { location: fallbackLocation(slug), hop: false, via: "fallback" };
}
