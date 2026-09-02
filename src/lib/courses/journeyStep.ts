/**
 * WHERE THE READER IS IN THE TERM'S JOURNEY.
 *
 * The public programme page ends with a strip of the term's shape:
 * applications open, applications close, decisions, first session, last
 * session. Each step may carry a civil date key ("YYYY-MM-DD", Europe/London,
 * validated at the write end by `sanitizeJourney`), and the strip marks which
 * one the visitor is standing in.
 *
 * ## Why a pure function on a date KEY, and not `new Date()` anywhere near it
 *
 * The comparison is between two civil dates in Nottingham. Doing it on
 * instants means asking a browser in Los Angeles what day it is, and the
 * answer is off by one for eight hours of every London day: "applications
 * close today" would appear a day late for a visitor abroad and a day early
 * for the page rendered just after London midnight. So the caller passes
 * `londonDateKey(new Date())` and this module does string comparison, which is
 * exact because "YYYY-MM-DD" sorts lexicographically the same way it sorts
 * chronologically.
 *
 * That also makes the day boundary testable without mocking a clock: the two
 * instants either side of London midnight produce two different keys, and the
 * step flips between them.
 */

/** The one field of a journey step this module reads. */
export type DatedStep = { dateKey?: string };

/**
 * The index of the step the reader is currently in, or -1 when the term has
 * not started (today is before every dated step, or no step carries a date).
 *
 * "Currently in" means the LATEST step whose date has arrived, counting today
 * as arrived: on the day applications close, the close step is the current
 * one, not the one after it. Undated steps never become current on their own,
 * because there is no day on which to say they have started; they take their
 * appearance from where they sit relative to the answer, which is the caller's
 * business.
 *
 * Ties go to the LATER step. Two steps can honestly share a day ("applications
 * close" and "decisions start" both on Sunday), and the one further down the
 * strip is the one the reader is heading into.
 */
export function currentJourneyStepIndex(
  steps: readonly DatedStep[],
  todayKey: string,
): number {
  let current = -1;
  let currentKey = "";
  for (let i = 0; i < steps.length; i += 1) {
    const key = steps[i]?.dateKey;
    if (!key) continue;
    if (key > todayKey) continue;
    // `>=` rather than `>`: a later step sharing the same day wins the tie.
    if (current === -1 || key >= currentKey) {
      current = i;
      currentKey = key;
    }
  }
  return current;
}

/** How one step of the strip renders. */
export type JourneyStepState = "past" | "current" | "upcoming";

/**
 * The state of every step in one pass, so the strip does not recompute the
 * index per row and cannot disagree with itself about where the reader is.
 */
export function journeyStepStates(
  steps: readonly DatedStep[],
  todayKey: string,
): JourneyStepState[] {
  const current = currentJourneyStepIndex(steps, todayKey);
  return steps.map((_, i) => {
    if (current === -1) return "upcoming";
    if (i < current) return "past";
    if (i === current) return "current";
    return "upcoming";
  });
}
