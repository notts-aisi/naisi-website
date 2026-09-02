import {
  roundWindowState,
  type RoundWindow,
  type RoundWindowInput,
} from "./window";

/**
 * WHICH ROUND A COURSE'S PUBLIC PAGE SPEAKS ABOUT.
 *
 * A course does not own a round and a round does not belong to a course: one
 * autumn intake feeds the research incubator and up to three fellowship runs,
 * so the join is `admissionRounds.outcomeRunIds` pointing at course RUNS. The
 * public programme page therefore has to ask the question backwards ("which
 * rounds name one of my runs?") and then pick one, because a course with a
 * spring round already authored beside a live autumn one has two.
 *
 * The FETCH half of that lives in `src/features/courses/fetchLiveRound.ts`
 * (Admin SDK, server only). This module is the CHOICE half, kept pure so the
 * ranking can be pinned by a test rather than reasoned about: open beats
 * opening-soon beats closed, and "no round at all" is a real answer that sends
 * the page back to the run's own window.
 *
 * ## Draft rounds are NOT candidates, and that is a deliberate reading
 *
 * `roundWindowState()` calls a `draft` round `inactive`: "not a public thing
 * at all", in that module's own words, answered with the same sentence as a
 * round that was never open so an applicant cannot tell which. This module
 * does not second-guess it. The consequence worth stating out loud, because
 * the delivery plan's PR sketch reads the other way, is that the "applications
 * open on Monday" state comes from a round whose STATUS is already `open` and
 * whose `opensAt` is still ahead, which is exactly the shape the round console
 * authors: an admin sets the dates and flips the round to open, and the dates
 * decide when the form appears. Advertising an unfinished draft's date on a
 * marketing page would promise a date nobody has committed to yet.
 *
 * ## `courseRuns.admissionRoundIds` does not exist yet
 *
 * PR17 adds the forward pointer, at which point the query below becomes a
 * lookup by id and this ranking stays exactly as it is. Nothing here reads the
 * pointer, so the two land in either order.
 */

/**
 * The round fields the choice depends on: the window's four, plus the id used
 * as the last tie-break. A structural type, not `AdmissionRoundDoc`, so the
 * ranking stays testable without building a whole round and so nothing here
 * can quietly start reading a fifth field.
 */
export type LiveRoundCandidate = RoundWindowInput & { id: string };

export type LiveRound<T extends LiveRoundCandidate = LiveRoundCandidate> = {
  round: T;
  window: RoundWindow;
};

/**
 * Taking applications beats opening soon beats already closed. `inactive`
 * never appears: candidates carrying it are dropped before any comparison, so
 * it has no rank.
 */
const RANK = { open: 0, "not-yet": 1, closed: 2 } as const;

/**
 * Soonest-closing first among rounds that are still ahead of their deadline,
 * so a course whose autumn intake shuts on Sunday advertises that rather than
 * a spring round closing in December. An unbounded window sorts last; the id
 * breaks the remaining tie so the answer is stable across requests instead of
 * being whatever order Firestore returned.
 */
function preferLiveRound<T extends LiveRoundCandidate>(a: T, b: T): T {
  const av = a.closesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bv = b.closesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (av !== bv) return av < bv ? a : b;
  const ao = a.opensAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bo = b.opensAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

/**
 * The mirror for rounds that have already shut: the MOST RECENTLY closed
 * wins, because that is the one an applicant is asking about in the fortnight
 * between the deadline and the decision. A round with no `closesAt` carries no
 * recency signal at all (an admin closed it by hand), so it sorts last rather
 * than pretending to be the newest.
 */
function preferClosedRound<T extends LiveRoundCandidate>(a: T, b: T): T {
  const av = a.closesAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bv = b.closesAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (av !== bv) return av > bv ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

/**
 * Pick the round a course's public surfaces should describe, or null when no
 * round names any of the course's runs. Null is not a failure: the page falls
 * back to the run's own application or enrolment window, which is how every
 * course behaved before rounds existed and how an open-enrolment pre-course
 * behaves for good.
 *
 * ONE clock reading for every candidate (the caller's `now`), so the ranking
 * is a total order and two rounds cannot land on opposite sides of the same
 * deadline within one render.
 */
export function pickLiveRound<T extends LiveRoundCandidate>(
  candidates: T[],
  now: Date,
): LiveRound<T> | null {
  let best: LiveRound<T> | null = null;
  for (const round of candidates) {
    const window = roundWindowState(round, now);
    // Draft and archived alike. See the module comment: an unfinished round is
    // not a public thing, and an archived one has been withdrawn.
    if (window.state === "inactive") continue;
    if (!best) {
      best = { round, window };
      continue;
    }
    const bestRank = RANK[best.window.state as keyof typeof RANK];
    const rank = RANK[window.state as keyof typeof RANK];
    if (rank < bestRank) {
      best = { round, window };
      continue;
    }
    if (rank > bestRank) continue;
    const winner =
      window.state === "closed"
        ? preferClosedRound(best.round, round)
        : preferLiveRound(best.round, round);
    if (winner !== best.round) best = { round, window };
  }
  return best;
}
