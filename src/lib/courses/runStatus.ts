import type { CourseRunStatus } from "@/lib/firestore/courses";

/**
 * The run lifecycle, as a table rather than scattered `if`s:
 *
 *   draft -> applications-open -> applications-closed -> running -> completed
 *
 * plus `cancelled`, reachable from any state that has not finished. Nothing
 * leaves `completed` or `cancelled`: both are terminal, because a run that
 * has ended (or been called off) has already had its emails sent and its
 * enrolments settled, and "un-completing" it would silently re-arm every
 * date-driven surface that reads the status.
 *
 * Deliberately forward-only: re-opening a closed application window is NOT
 * modelled here. If that turns out to be wanted, it is a table entry plus a
 * decision about what happens to already-rejected applicants, not something
 * to fall into by accident.
 *
 * This module is the SINGLE source of truth. The status route enforces it,
 * the run editor's dropdown is built from it, and `firestore.rules` mirrors
 * it, so the admin is never offered a move the server will refuse and an
 * approver cannot reach one client-direct. Anything that wants to know "can
 * this run go there" imports `canTransition` rather than restating the table.
 *
 * KEEP THE RULES MIRROR IN STEP. `firestore.rules` carries the same table as
 * a literal in `runStatusMoveAllowed()` on the `courseRuns` block. It exists
 * because the week-plan freeze is keyed on the status: without it an approver
 * could walk a live run back to `draft`, edit the frozen plan, and walk it
 * forward again, and the freeze would be three writes from defeated. Editing
 * this table without editing that one leaves the two disagreeing, and the
 * rules half is the one that decides.
 */
export const ALLOWED_TRANSITIONS: Record<CourseRunStatus, CourseRunStatus[]> = {
  draft: ["applications-open", "cancelled"],
  // OPEN ENROLMENT is why `running` is reachable directly from here. An
  // open-mode run (the pre-course) has no review stage to close: sign-ups
  // stay open into the first weeks of teaching, so the cohort starts while
  // the window is still open, and forcing it through `applications-closed`
  // would shut the door the mode exists to leave open. The admissions path
  // is unaffected and still closes first.
  "applications-open": ["applications-closed", "running", "cancelled"],
  "applications-closed": ["running", "cancelled"],
  running: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/**
 * Whether the server will accept `from -> to`. Re-sending the status a run
 * already has is treated as legal here because the route handles it as an
 * idempotent no-op rather than an error.
 */
export function canTransition(from: CourseRunStatus, to: CourseRunStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}
