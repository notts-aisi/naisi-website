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

/**
 * This member's attendance across the run, as one rolled-up row.
 *
 * FULL RECOMPUTE, NEVER A DELTA. The attendance push recomputes this member's
 * whole record from their group's PUSHED registers inside the push
 * transaction, rather than adding one to a counter. That is the direct lesson
 * from `applicationCounts`, which moves only as relative increments, has no
 * recount pass anywhere, and is therefore unreconcilable once it drifts. A
 * rollup that can be rebuilt from its source at any time cannot drift at all.
 *
 * `sessionsHeld` counts only registers marked `held`, so a cancelled session
 * leaves every ratio built on this alone rather than silently deflating it.
 *
 * `lastPushedSessionKey` is the idempotency marker: a re-push of the same
 * session recomputes to the same numbers, and the key says which session the
 * figures are current as of.
 */
export type EnrolmentAttendanceRollup = {
  sessionsHeld: number;
  attendedInFull: number;
  late: number;
  leftEarly: number;
  absent: number;
  excused: number;
  lastPushedSessionKey: string | null;
  lastComputedAt: Date | null;
};

export const EMPTY_ATTENDANCE_ROLLUP: EnrolmentAttendanceRollup = {
  sessionsHeld: 0,
  attendedInFull: 0,
  late: 0,
  leftEarly: 0,
  absent: 0,
  excused: 0,
  lastPushedSessionKey: null,
  lastComputedAt: null,
};

export const ENROLMENT_LIMITS = {
  /** Free text a member types when they drop out. Optional, and never shown
      back to the cohort: it goes to the staff review surface only. */
  dropOutReason: 500,
} as const;

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
  /**
   * The run stream this member is on (`courseRuns.streams[].id`), or null on
   * a run with no streams. Scopes which of a week's materials, exercises and
   * checklist items they see, through `src/lib/courses/streamScope.ts`.
   *
   * The whole collection is already `allow write: if false`, so this is
   * server-owned by construction, which is precisely why the run's `streams`
   * list had to move to the server-owned tier too: a client-direct edit there
   * could invalidate the ids stored here.
   */
  streamId: string | null;
  /**
   * Rolled-up attendance (see `EnrolmentAttendanceRollup`). Living here, on a
   * row the member can already read, is what lets a learner see their own
   * attendance without any new read rule: the registers themselves stay
   * `read: if false` because one register carries the whole group's marks.
   */
  attendance: EnrolmentAttendanceRollup;
  /** Whether this member has cleared the run's submission bar
      (`courseRuns.submissionExerciseRef`). */
  submissionDone: boolean;
  /**
   * When the member dropped out themselves. Self-service drop-out is
   * IRREVERSIBLE by decision: it frees the seat and stops the nudges, and
   * coming back is a new enrolment rather than an undo. Null on every
   * enrolment that has not been dropped.
   */
  droppedOutAt: Date | null;
  /** Optional free text from the drop-out form (see `ENROLMENT_LIMITS`). */
  dropOutReason: string | null;
  /**
   * True when the member enrolled themselves on an OPEN-mode run, false when
   * a seat was allocated to them out of admissions. Kept as its own field
   * rather than derived from `applicationId == null`, because a direct
   * admin-created enrolment is also application-less and is not self-service.
   */
  selfEnrolled: boolean;
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

function asCount(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function asAttendanceRollup(v: unknown): EnrolmentAttendanceRollup {
  const raw = (v ?? {}) as Raw;
  return {
    sessionsHeld: asCount(raw.sessionsHeld),
    attendedInFull: asCount(raw.attendedInFull),
    late: asCount(raw.late),
    leftEarly: asCount(raw.leftEarly),
    absent: asCount(raw.absent),
    excused: asCount(raw.excused),
    lastPushedSessionKey:
      typeof raw.lastPushedSessionKey === "string" && raw.lastPushedSessionKey
        ? raw.lastPushedSessionKey
        : null,
    lastComputedAt: tsToDate(raw.lastComputedAt),
  };
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
    streamId:
      typeof data.streamId === "string" && data.streamId ? data.streamId : null,
    attendance: asAttendanceRollup(data.attendance),
    submissionDone: data.submissionDone === true,
    droppedOutAt: tsToDate(data.droppedOutAt),
    dropOutReason:
      typeof data.dropOutReason === "string" && data.dropOutReason
        ? data.dropOutReason.slice(0, ENROLMENT_LIMITS.dropOutReason)
        : null,
    selfEnrolled: data.selfEnrolled === true,
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
