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
 * This module is the SINGLE source of truth. The status route enforces it and
 * the run editor's dropdown is built from it, so the admin is never offered a
 * move the server will refuse. Anything that wants to know "can this run go
 * there" imports `canTransition` rather than restating the table.
 */
export const ALLOWED_TRANSITIONS: Record<CourseRunStatus, CourseRunStatus[]> = {
  draft: ["applications-open", "cancelled"],
  "applications-open": ["applications-closed", "cancelled"],
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
