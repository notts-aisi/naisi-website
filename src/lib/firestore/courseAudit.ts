/**
 * `courseAudit/{autoId}` — ONE append-only log for every course operational
 * action that has to stay answerable after the fact.
 *
 * WHY ONE COLLECTION AND NOT ONE PER FEATURE. The codebase already carries
 * three per-feature audits (`impersonations`, `courseDeletions`,
 * `subscriptionEvents`) and no general one, so every new course action that
 * wanted logging was reaching for a fourth, a fifth and a sixth. The
 * questions asked of them are the same questions — who did this, to what,
 * when, and what did they say about it — and answering "what happened to this
 * run" across six collections is six queries and six chances to forget one.
 * `kind` is the discriminator; `runId` is the query axis.
 *
 * APPEND-ONLY, AND WRITE-SHUT TO EVERY CLIENT INCLUDING ADMINS. This is the
 * `courseDeletions` posture verbatim, for the reason stated there: an audit
 * its own actor can amend is not an audit. Reads are admin-only. Every writer
 * is an Admin SDK route.
 *
 * NOT SWEPT BY ACCOUNT DELETION, and that is a decision rather than an
 * oversight. A row here names the ACTOR of a staff action (and sometimes its
 * subject), and erasing the record of who read a member's access
 * requirements, or who put a run into open enrolment, because that person
 * later deleted their account would destroy the only evidence the action ever
 * happened. `impersonations` and `courseDeletions` are retained on exactly
 * the same reasoning and are likewise not swept. The rows are staff-action
 * metadata, not member content: nothing here holds an applicant's answers,
 * their access requirements, or a facilitator's notes about them, only the
 * fact that a named actor touched them. The DESTROY cascade does clear them
 * per run, because destroying a run destroys the things the rows describe.
 */

export const COURSE_AUDIT_COLLECTION = "courseAudit";

/**
 * What happened. Kept deliberately coarse: a kind earns its place when
 * somebody would go looking for it by name.
 */
export type CourseAuditKind =
  /** An admin edited a register after it was pushed and locked. */
  | "attendance-edit"
  /** A facilitator pressed PUSH ATTENDANCE, locking one register. */
  | "attendance-push"
  /** Staff opened a week's content before its lock date released it. */
  | "week-lock-override"
  | "facilitator-appointed"
  | "facilitator-removed"
  /** A member dropped themselves out of a run. */
  | "enrolment-dropout"
  /** A run moved between admissions and open enrolment. */
  | "enrol-mode-change"
  /** A run was settled: enrolments closed out and completion decided. */
  | "run-settled"
  /**
   * Somebody read an applicant's access-requirements answer. Logged because
   * that answer is health and disability information held deliberately
   * outside the scored payload, and "who has read it" is the only control
   * left once a route can serve it at all.
   */
  | "access-requirements-read";

export const COURSE_AUDIT_KINDS: CourseAuditKind[] = [
  "attendance-edit",
  "attendance-push",
  "week-lock-override",
  "facilitator-appointed",
  "facilitator-removed",
  "enrolment-dropout",
  "enrol-mode-change",
  "run-settled",
  "access-requirements-read",
];

export const COURSE_AUDIT_KIND_LABEL: Record<CourseAuditKind, string> = {
  "attendance-edit": "Register edited after push",
  "attendance-push": "Register pushed",
  "week-lock-override": "Week unlocked early",
  "facilitator-appointed": "Facilitator appointed",
  "facilitator-removed": "Facilitator removed",
  "enrolment-dropout": "Member dropped out",
  "enrol-mode-change": "Enrolment mode changed",
  "run-settled": "Run settled",
  "access-requirements-read": "Access requirements read",
};

export const COURSE_AUDIT_LIMITS = {
  /** Human sentence describing the row, shown verbatim in the admin log. */
  detail: 1000,
  actorName: 120,
  targetLabel: 200,
} as const;

export type CourseAuditDoc = {
  /** Firestore auto-id. Rows are never addressed individually. */
  id: string;
  kind: CourseAuditKind;
  /**
   * The run the action belongs to. THE query axis, and the key the destroy
   * cascade drains on, so a row without one is unreachable by both. Rows for
   * an action with no run (there are none today) would store "".
   */
  runId: string;
  /** Optional narrower subjects, stored so a query can reach them later. */
  groupId: string | null;
  /** The member the action was ABOUT, when it was about one. */
  subjectUid: string | null;
  actorUid: string;
  actorName: string;
  /** Free-text label of the thing acted on, e.g. a week or a register id. */
  targetLabel: string;
  /** One human sentence: what changed, and from what to what. */
  detail: string;
  at: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function normalizeCourseAudit(id: string, data: Raw): CourseAuditDoc {
  const kind = data.kind as CourseAuditKind;
  return {
    id,
    // A kind this build does not recognise degrades to `attendance-edit`
    // rather than being dropped: the row still has to appear in the log, and
    // `detail` carries the sentence a reader actually needs. The alternative,
    // hiding the row, would let a rollback silently shrink an audit trail.
    kind: COURSE_AUDIT_KINDS.includes(kind) ? kind : "attendance-edit",
    runId: typeof data.runId === "string" ? data.runId : "",
    groupId: strOrNull(data.groupId),
    subjectUid: strOrNull(data.subjectUid),
    actorUid: typeof data.actorUid === "string" ? data.actorUid : "",
    actorName: str(data.actorName, COURSE_AUDIT_LIMITS.actorName),
    targetLabel: str(data.targetLabel, COURSE_AUDIT_LIMITS.targetLabel),
    detail: str(data.detail, COURSE_AUDIT_LIMITS.detail),
    at: tsToDate(data.at),
  };
}
