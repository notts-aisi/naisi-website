import { applicationWindow, type ApplicationWindowState } from "./window";
import type { CourseEnrolMode, CourseRunStatus } from "@/lib/firestore/courses";

/**
 * The OPEN-ENROLMENT window for one course run: the single predicate every
 * surface calls before it offers, or accepts, a click-enrol.
 *
 * ## Why this is not `applicationWindow()`
 *
 * They read the same two dates off the same document and they answer
 * different questions, so folding them together would make each one wrong
 * for the other's caller:
 *
 *  - `applicationWindow()` is about APPLYING. It closes the moment a run
 *    leaves `applications-open`, because an admin moving the run on is an
 *    admin closing the queue.
 *  - this one is about GETTING A SEAT on a run that has no queue at all. The
 *    pre-course admits people while it is running: someone who finds the
 *    bootcamp in week two and wants the remaining four sessions is exactly
 *    the person open enrolment exists for, and `applications-closed` is the
 *    status that run sits in for most of its life (its parent intake's
 *    applications shut on 18 October while the sessions keep going).
 *
 * Hence the WIDENED STATUS SET below. It is the whole behavioural difference
 * between the two predicates, and it is deliberate rather than lax: `draft`
 * is unfinished authoring, `completed` and `cancelled` are over, `archived`
 * is withdrawn, and none of those may ever take a new member.
 *
 * ## Why it is separate from the admissions-round predicate too
 *
 * `src/lib/admissions/window.ts` answers the same shape of question about an
 * `admissionRounds` document: a different object, with different fields, on a
 * different lifecycle. One round feeds several runs, so there is no run whose
 * dates it could read. Sharing an implementation between them would mean one
 * function reading two unrelated schemas.
 *
 * ## Boundary semantics
 *
 * Both bounds are INCLUSIVE, matching `applicationWindow()` exactly: at
 * `applicationsOpenAt` you are in, and at `applicationsCloseAt` you are still
 * in. A null bound means "no automatic limit on that side", never "closed".
 *
 * ## Why the fields are called `applicationsOpenAt` / `applicationsCloseAt`
 *
 * Because renaming them would be a data migration for cosmetics. On an
 * `admissions` run they bound the application window; on an `open` run they
 * bound the enrolment window. The dual role is documented on `CourseRunDoc`
 * and enforced here: nothing else in the codebase may read those two fields
 * without first branching on `enrolMode`.
 */

/** Same vocabulary as the application window, so one CTA can render either. */
export type EnrolWindowState = ApplicationWindowState;

export type EnrolWindow = {
  state: EnrolWindowState;
  /** The run's `applicationsOpenAt`, echoed back so callers can render it. */
  opensAt: Date | null;
  /** The run's `applicationsCloseAt`. Null = no automatic deadline. */
  closesAt: Date | null;
};

/**
 * The five run fields the enrolment window depends on. A structural type
 * rather than `CourseRunDoc` so the predicate stays testable without building
 * a whole run document, and so nothing here can quietly start reading a
 * sixth field.
 */
export type EnrolWindowRun = {
  status: CourseRunStatus;
  enrolMode: CourseEnrolMode;
  archived: boolean;
  applicationsOpenAt: Date | null;
  applicationsCloseAt: Date | null;
};

/**
 * The statuses in which an open-mode run admits a new enrolment, all three of
 * them, provided the dates agree. Written out rather than derived from a
 * negation so adding a status to `CourseRunStatus` is a decision here rather
 * than an accident.
 */
export const ENROLLING_RUN_STATUSES: CourseRunStatus[] = [
  "applications-open",
  "applications-closed",
  "running",
];

export function enrolWindow(run: EnrolWindowRun, now: Date): EnrolWindow {
  const opensAt = run.applicationsOpenAt ?? null;
  const closesAt = run.applicationsCloseAt ?? null;
  const bounds = { opensAt, closesAt };

  // An admissions run has no enrolment window at all: its seats come out of
  // review and allocation. `inactive` rather than `closed`, because "closed"
  // would invite a surface to say "enrolment has closed" about a run that
  // never offered it.
  if (run.enrolMode !== "open") return { state: "inactive", ...bounds };

  // Archived first: orthogonal to status, and the flag the destroy cascade
  // sets in its opening write, so a run mid-destroy is off every enrol
  // surface before its first row dies.
  if (run.archived) return { state: "inactive", ...bounds };
  if (run.status === "draft") return { state: "inactive", ...bounds };
  if (!ENROLLING_RUN_STATUSES.includes(run.status)) {
    // `completed` and `cancelled`: the run was a public thing and is over.
    return { state: "closed", ...bounds };
  }

  const at = now.getTime();
  if (opensAt && at < opensAt.getTime()) return { state: "not-yet", ...bounds };
  if (closesAt && at > closesAt.getTime()) return { state: "closed", ...bounds };
  return { state: "open", ...bounds };
}

/**
 * Is this run taking click-enrolments right now? The one boolean the enrol
 * route gates on, and the one every enrol affordance is rendered behind.
 */
export function isEnrolOpen(run: EnrolWindowRun, now: Date): boolean {
  return enrolWindow(run, now).state === "open";
}

/**
 * The window a PUBLIC surface should describe for this run, whichever way
 * people get onto it: the enrolment window for an open run, the application
 * window for an admissions one.
 *
 * The dispatcher lives here, and not in `window.ts`, so that every caller
 * that must branch on `enrolMode` imports the module whose whole subject is
 * that branch. A catalogue card or a CTA that called `applicationWindow()`
 * directly on an open-mode run would report "applications closed" about a
 * bootcamp that is taking sign-ups right now, which is the same class of
 * disagreement `window.ts` was written to end.
 */
export function courseRunWindow(run: EnrolWindowRun, now: Date): EnrolWindow {
  return run.enrolMode === "open"
    ? enrolWindow(run, now)
    : applicationWindow(run, now);
}
