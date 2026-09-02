import { COURSE_TZ } from "./weekPlan";
import type { CourseRunStatus } from "@/lib/firestore/courses";

/**
 * The application window for one course run: ONE predicate, shared by every
 * surface that has an opinion about whether you can apply.
 *
 * ## Why this module exists
 *
 * Discovery and submit used to disagree. The catalogue card, the course page
 * CTA and the apply page all keyed on `run.status === "applications-open"`
 * alone, while the apply route ALSO enforced `applicationsOpenAt` and
 * `applicationsCloseAt`. So a run left in `applications-open` past its
 * deadline advertised an open application, rendered the whole form, and then
 * refused the POST with "Applications for this run have closed." after the
 * applicant had written five hundred words into it. The mirror case was as
 * bad: a run opened with a future `applicationsOpenAt` showed an Apply button
 * that answered "Applications for this run haven't opened yet."
 *
 * Every one of those surfaces now calls `applicationWindow()`, including the
 * route's own `windowError`, so the sentence a browser reads and the decision
 * the server makes come from the same three lines of arithmetic. They cannot
 * drift again without this file changing.
 *
 * ## The states
 *
 *  - `inactive`: the run is not a public thing at all, either a `draft` (unfinished
 *    authoring) or an `archived` one (withdrawn, and the state the destroy
 *    cascade sets before it deletes a single row). Public fetchers drop these
 *    entirely; the route refuses them with the same sentence it gives a run
 *    that was never open, because an applicant has no business learning which.
 *  - `not-yet`: status says open, but `applicationsOpenAt` is still ahead.
 *    Advertise the date; do not offer a form.
 *  - `open`: status says open and now sits inside both bounds. A null bound
 *    means "no automatic limit on that side", never "closed".
 *  - `closed`: either the deadline has passed, or an admin has moved the run
 *    on (`applications-closed`, `running`, `completed`, `cancelled`). The
 *    status wins over the dates here: a run flipped to `applications-closed`
 *    early IS closed, whatever `applicationsCloseAt` still says.
 *
 * ## Boundary semantics
 *
 * Both bounds are INCLUSIVE, matching what the route has always enforced:
 * exactly at `applicationsOpenAt` you are in, and exactly at
 * `applicationsCloseAt` you are still in. A deadline of 23:59 therefore means
 * 23:59:00.000 is the last accepted instant, which is what "closes at 23:59"
 * reads as to a person.
 */

export type ApplicationWindowState = "inactive" | "not-yet" | "open" | "closed";

export type ApplicationWindow = {
  state: ApplicationWindowState;
  /** The run's `applicationsOpenAt`, echoed back so callers can render it. */
  opensAt: Date | null;
  /** The run's `applicationsCloseAt`. Null = no automatic deadline. */
  closesAt: Date | null;
};

/**
 * The four run fields the window depends on. A structural type rather than
 * `CourseRunDoc` so the predicate stays testable without building a whole run
 * document, and so nothing here can quietly start reading a fifth field.
 */
export type ApplicationWindowRun = {
  status: CourseRunStatus;
  archived: boolean;
  applicationsOpenAt: Date | null;
  applicationsCloseAt: Date | null;
};

export function applicationWindow(
  run: ApplicationWindowRun,
  now: Date,
): ApplicationWindow {
  const opensAt = run.applicationsOpenAt ?? null;
  const closesAt = run.applicationsCloseAt ?? null;
  const bounds = { opensAt, closesAt };

  // Archived first: it is orthogonal to status, and it closes the window
  // regardless of what the status says.
  if (run.archived) return { state: "inactive", ...bounds };
  if (run.status === "draft") return { state: "inactive", ...bounds };
  if (run.status !== "applications-open") return { state: "closed", ...bounds };

  const at = now.getTime();
  if (opensAt && at < opensAt.getTime()) return { state: "not-yet", ...bounds };
  if (closesAt && at > closesAt.getTime()) return { state: "closed", ...bounds };
  return { state: "open", ...bounds };
}

// ---------------------------------------------------------------------------
// Date labels
// ---------------------------------------------------------------------------

/**
 * Public course dates are rendered in Europe/London, never the viewer's zone.
 * A Nottingham reading group meets in Nottingham, and an applicant abroad
 * needs the deadline in the timezone the deadline was written in, not a
 * helpfully shifted one that lands them a day late.
 *
 * These all format on the SERVER (the public course surfaces are server
 * components), so there is no hydration skew to worry about either.
 */

/** "Sun 18 Oct", the compact label the catalogue and CTAs use. */
export function formatWindowDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** "Sun 18 Oct, 23:59", for a deadline where the time of day is load-bearing. */
export function formatWindowDeadline(date: Date): string {
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

/**
 * "Sun 18 Oct 2026", for a date that has already passed.
 *
 * The year is not decoration here. A deadline in the future is always the
 * next one of its kind, so "Sun 18 Oct" is unambiguous; a deadline in the
 * PAST might belong to a run from a previous academic year, and the same
 * label without a year reads as "you missed it by a fortnight" rather than
 * "that cohort ran last autumn".
 */
export function formatPastWindowDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/**
 * Turn a run's CIVIL start date ("YYYY-MM-DD", Europe/London) into an instant
 * safe to format. Noon UTC: far enough from either edge that no DST shift can
 * move the calendar date. Returns null for anything that is not a date key,
 * because a half-authored draft run legitimately has none.
 */
function civilDateToInstant(civil: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(civil)) return null;
  const at = new Date(`${civil}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "Mon 26 Oct" from a run's `startDate`. Undefined when it isn't set yet. */
export function formatRunStartShort(startDate: string): string | undefined {
  const at = civilDateToInstant(startDate);
  return at ? formatWindowDate(at) : undefined;
}

/**
 * "Monday 6 October" from a run's `startDate`: the long form the acceptance
 * and confirmation emails have always used. Lives here rather than in the
 * apply route so the one civil-date-to-London-label conversion on the site has
 * one home; the output is byte-identical to the route's old local copy.
 */
export function formatRunStart(startDate: string): string | undefined {
  const at = civilDateToInstant(startDate);
  if (!at) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
}
