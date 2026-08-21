import { weekDocId } from "./courses";

/**
 * `courseAttendance/{runId}__{groupId}__wNN` — one register per (group,
 * week). ALL access is server-routed (`read/write: if false` in rules): the
 * records map is keyed by member uid, which is roster information the
 * PII-free facilitator surface serves with names attached via the roster
 * route, never by client reads.
 *
 * One doc per register (not one per member-week) keeps marking a whole
 * session a single write, and the deterministic id makes re-marking an
 * upsert of the same doc — no duplicate registers, no query to find one.
 * Account deletion removes a member by MAP-KEY deletion (FieldPath), not doc
 * deletion, since the register is shared.
 */

export type AttendanceStatus = "present" | "absent" | "excused" | "late";

export const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  "present",
  "absent",
  "excused",
  "late",
];

export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: "Present",
  absent: "Absent",
  excused: "Excused",
  late: "Late",
};

export const ATTENDANCE_LIMITS = {
  /** Cap on uids per register — a group is never anywhere near this big. */
  maxRecords: 40,
  notes: 1000,
} as const;

export type CourseAttendanceDoc = {
  /** Firestore doc id: `attendanceDocId(runId, groupId, weekNumber)`. */
  id: string;
  runId: string;
  groupId: string;
  weekNumber: number;
  /** Per-member status, keyed by uid. Max 40 entries. */
  records: Record<string, AttendanceStatus>;
  /**
   * When the session actually happened — resolved from the group's slot (or
   * that week's override) at marking time. Absent when never resolved.
   */
  sessionAt?: Date;
  /** Facilitator note on the session (plain text). */
  notes?: string;
  markedByUid: string;
  updatedAt?: Date | null;
};

/**
 * Deterministic doc id — one register per (run, group, week), structurally
 * (see module comment). Reuses `weekDocId` so the suffix sorts in week order
 * in the console. CONSTRUCT-ONLY — the parts are stored as fields; never
 * parse the id (`slugId`-made ids already contain `__`).
 */
export function attendanceDocId(
  runId: string,
  groupId: string,
  weekNumber: number,
): string {
  return `${runId}__${groupId}__${weekDocId(weekNumber)}`;
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

function asRecords(v: unknown): Record<string, AttendanceStatus> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, AttendanceStatus> = {};
  let count = 0;
  for (const [uid, status] of Object.entries(v as Record<string, unknown>)) {
    if (count >= ATTENDANCE_LIMITS.maxRecords) break;
    if (!ATTENDANCE_STATUSES.includes(status as AttendanceStatus)) continue;
    out[uid] = status as AttendanceStatus;
    count += 1;
  }
  return out;
}

export function normalizeCourseAttendance(id: string, data: Raw): CourseAttendanceDoc {
  const doc: CourseAttendanceDoc = {
    id,
    runId: str(data.runId),
    groupId: str(data.groupId),
    weekNumber:
      typeof data.weekNumber === "number" && Number.isFinite(data.weekNumber)
        ? Math.floor(data.weekNumber)
        : 0,
    records: asRecords(data.records),
    markedByUid: str(data.markedByUid),
    updatedAt: tsToDate(data.updatedAt),
  };
  const sessionAt = tsToDate(data.sessionAt);
  if (sessionAt) doc.sessionAt = sessionAt;
  if (typeof data.notes === "string" && data.notes) {
    doc.notes = data.notes.slice(0, ATTENDANCE_LIMITS.notes);
  }
  return doc;
}
