/**
 * `courseEnrolments/{runId}__{uid}` — one member's place on one course run.
 * ALL writes go through server routes (`allow write: if false` in rules):
 * enrolment is the outcome of allocation, and the group `memberCount`
 * counters must move in the same transaction.
 *
 * The deterministic doc id IS the no-double-placement invariant: one
 * enrolment per (run, uid) exists structurally, and `groupId` is a single
 * scalar — a member cannot be in two groups because there is nowhere to
 * store a second placement. Moving groups is one scalar update plus two
 * counter deltas; "everyone placed" is a count of `groupId == null` rows.
 */

export type CourseEnrolmentStatus = "active" | "withdrawn" | "removed" | "completed";

export const ENROLMENT_STATUSES: CourseEnrolmentStatus[] = [
  "active",
  "withdrawn",
  "removed",
  "completed",
];

export const ENROLMENT_STATUS_LABEL: Record<CourseEnrolmentStatus, string> = {
  active: "Active",
  withdrawn: "Withdrawn",
  removed: "Removed",
  completed: "Completed",
};

/**
 * Facilitators get a `role: "facilitator"` enrolment when assigned to a
 * group, so "every run you touch" on /learn is one query over enrolments.
 */
export type CourseEnrolmentRole = "learner" | "facilitator";

export type CourseEnrolmentDoc = {
  /** Firestore doc id: `courseEnrolmentId(runId, uid)`. */
  id: string;
  runId: string;
  courseId: string;
  uid: string;
  /**
   * The single group placement — scalar by design (see module comment).
   * Null = accepted but not yet allocated to a group.
   */
  groupId: string | null;
  status: CourseEnrolmentStatus;
  role: CourseEnrolmentRole;
  /** The application this enrolment came from; null for direct enrolments. */
  applicationId: string | null;
  /**
   * The cohort week at which this member joined. Scopes every progress
   * percentage and the attendance grid so mid-run joiners aren't shown as
   * "behind" on weeks that predate them.
   */
  joinedWeekNumber: number;
  /**
   * High-water mark for the lazy My Work task mirroring (see courseTasks.ts):
   * the sync-tasks route short-circuits when this already equals the current
   * anchor week, so the common case is one doc read and zero writes.
   */
  lastTaskSyncedWeek?: number;
  /**
   * When the "you've been placed" email for the CURRENT `groupId` was sent.
   * The idempotency guard for allocation publish: re-publishing a run emails
   * only enrolments lacking this stamp, so newly placed people get their
   * email and everyone already told does not get it twice. The allocate route
   * clears it whenever `groupId` changes — the stamp certifies "emailed about
   * their current group", and a move invalidates that.
   */
  allocatedEmailAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

/**
 * Deterministic doc id — see module comment for why this is the invariant.
 * CONSTRUCT-ONLY: `runId` and `uid` are stored as fields, so lookups use
 * queries or this constructor, never id parsing. Also the O(1) existence
 * check rules use for `isEnrolledActive()` (a `get()` on the exact path,
 * no array scan).
 */
export function courseEnrolmentId(runId: string, uid: string): string {
  return `${runId}__${uid}`;
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function normalizeCourseEnrolment(id: string, data: Raw): CourseEnrolmentDoc {
  const status = data.status as CourseEnrolmentStatus;
  const doc: CourseEnrolmentDoc = {
    id,
    runId: str(data.runId),
    courseId: str(data.courseId),
    uid: str(data.uid),
    groupId: (data.groupId as string | null | undefined) ?? null,
    status: ENROLMENT_STATUSES.includes(status) ? status : "active",
    role: data.role === "facilitator" ? "facilitator" : "learner",
    applicationId: (data.applicationId as string | null | undefined) ?? null,
    joinedWeekNumber:
      typeof data.joinedWeekNumber === "number" && Number.isFinite(data.joinedWeekNumber)
        ? Math.max(1, Math.floor(data.joinedWeekNumber))
        : 1,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
  if (
    typeof data.lastTaskSyncedWeek === "number" &&
    Number.isFinite(data.lastTaskSyncedWeek)
  ) {
    doc.lastTaskSyncedWeek = Math.floor(data.lastTaskSyncedWeek);
  }
  const allocatedEmailAt = tsToDate(data.allocatedEmailAt);
  if (allocatedEmailAt) doc.allocatedEmailAt = allocatedEmailAt;
  return doc;
}
