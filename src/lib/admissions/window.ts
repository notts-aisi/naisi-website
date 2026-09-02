import type { AdmissionRoundStatus } from "@/lib/firestore/admissionRounds";
import { COURSE_TZ } from "@/lib/courses/weekPlan";

/**
 * The application window for one admission round: ONE predicate, shared by
 * every surface that has an opinion about whether you can apply.
 *
 * ## Why this module exists, and why it is a near-copy
 *
 * `src/lib/courses/window.ts` exists because discovery and submit disagreed:
 * the catalogue advertised an open application while the route refused the
 * POST, after the applicant had written five hundred words into it. A round
 * has the same two halves (a public `/apply/[roundId]` page and a submit
 * route) and would grow the same bug, so it gets the same treatment: one
 * function, called by both, that cannot drift from itself.
 *
 * It is a SIBLING rather than a reuse because the two objects are genuinely
 * different. A run's window is derived from `CourseRunStatus` plus
 * `applicationsOpenAt` / `applicationsCloseAt` and is what open-enrol runs
 * use; a round's is derived from `AdmissionRoundStatus` plus `opensAt` /
 * `closesAt`, and the two status unions have no member in common. Folding
 * them together would mean a shared function switching on which kind of thing
 * it was handed, which is the shape that lets a change to one silently move
 * the other.
 *
 * ## The states
 *
 *  - `inactive`: not a public thing at all. A `draft` (unfinished authoring)
 *    or an `archived` round. The apply route answers these with the same
 *    sentence it gives a round that was never open, because an applicant has
 *    no business learning which.
 *  - `not-yet`: status says open, but `opensAt` is still ahead. Advertise the
 *    date; do not offer a form.
 *  - `open`: status says open and now sits inside both bounds. A null bound
 *    means "no automatic limit on that side", never "closed".
 *  - `closed`: either the deadline has passed, or an admin has moved the
 *    round on (`closed`, `deciding`, `settled`, `cancelled`). The status wins
 *    over the dates: a round closed early IS closed, whatever `closesAt`
 *    still says.
 *
 * ## Boundary semantics
 *
 * Both bounds are INCLUSIVE, matching the courses predicate exactly: at
 * `opensAt` you are in, and at `closesAt` you are still in. The autumn
 * deadline is 23:59 London on Sunday 18 October, so 23:59:00.000 London is
 * the last accepted instant, which is what "closes at 23:59" reads as to a
 * person. Deriving that instant from the civil date is the authoring route's
 * job; by the time it reaches this module it is a stored instant and the
 * comparison is plain arithmetic, which is why no clock change can move it.
 */

export type RoundWindowState = "inactive" | "not-yet" | "open" | "closed";

export type RoundWindow = {
  state: RoundWindowState;
  /** The round's `opensAt`, echoed back so callers can render it. */
  opensAt: Date | null;
  /** The round's `closesAt`. Null = no automatic deadline. */
  closesAt: Date | null;
};

/**
 * The four round fields the window depends on. A structural type rather than
 * `AdmissionRoundDoc` so the predicate stays testable without building a
 * whole round document, and so nothing here can quietly start reading a
 * fifth field.
 */
export type RoundWindowInput = {
  status: AdmissionRoundStatus;
  archived: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
};

export function roundWindowState(round: RoundWindowInput, now: Date): RoundWindow {
  const opensAt = round.opensAt ?? null;
  const closesAt = round.closesAt ?? null;
  const bounds = { opensAt, closesAt };

  // Archived first: it is orthogonal to status, and it closes the window
  // regardless of what the status says.
  if (round.archived) return { state: "inactive", ...bounds };
  if (round.status === "draft") return { state: "inactive", ...bounds };
  if (round.status !== "open") return { state: "closed", ...bounds };

  const at = now.getTime();
  if (opensAt && at < opensAt.getTime()) return { state: "not-yet", ...bounds };
  if (closesAt && at > closesAt.getTime()) return { state: "closed", ...bounds };
  return { state: "open", ...bounds };
}

/** Sugar for the one question most callers actually have. */
export function isRoundOpen(round: RoundWindowInput, now: Date): boolean {
  return roundWindowState(round, now).state === "open";
}

// ---------------------------------------------------------------------------
// Date labels
// ---------------------------------------------------------------------------

/**
 * Round dates render in Europe/London, never the viewer's zone, for the same
 * reason the course ones do: an applicant abroad needs the deadline in the
 * timezone the deadline was written in, not a helpfully shifted one that
 * lands them a day late.
 */

/** "Sun 18 Oct", the compact label the round card and CTAs use. */
export function formatRoundDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** "Sun 18 Oct, 23:59", for the deadline, where the time of day is load-bearing. */
export function formatRoundDeadline(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
