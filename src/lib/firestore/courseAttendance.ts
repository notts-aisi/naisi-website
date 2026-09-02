import { sessionKey } from "./courses";

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

/*
 * THE OCCURRENCE DIMENSION, AND WHAT IT COST TO ADD.
 *
 * A register belongs to one SESSION, not to one week: a group that meets
 * twice in a week holds two, and each needs its own marks, its own held
 * switch and its own push. `occurrence` is which of the week's sessions this
 * one is, and `src/lib/courses/sessions.ts` is what resolves them.
 *
 * IDS ARE BYTE-IDENTICAL FOR OCCURRENCE 1. `attendanceDocId` now builds its
 * suffix from `sessionKey(weekNumber, occurrence)`, and `sessionKey(n, 1)` is
 * `weekDocId(n)` exactly, so every register already written keeps its id,
 * nothing migrates, and account deletion's `documentId()` scan keeps working
 * unchanged. Occurrence 2 and up get a `-2` suffix, an id no week has ever
 * produced. That invariant is pinned by a test rather than left to care.
 *
 * WHAT IS STILL BLOCKED, and it is the other half of the same decision:
 * `courseGroups.extraSession` (the second slot itself) is not written by
 * `normalizeCourseGroup` yet, because the pre-course cadence is an owner
 * decision and the field is birth-pinned in rules. `sessionOverrides` and
 * `sessionModes` are likewise still keyed by week id with no occurrence
 * component, so a per-week room move or virtual switch reaches the week's
 * FIRST session only. Until those land every group resolves exactly one
 * session per taught week and every register is an occurrence-1 register. The
 * resolver, the ids, the register and the push are ready for the second one;
 * the data field is what is owed.
 *
 * THIS FILE IMPORTS NOTHING FROM `src/lib/courses`. It is pulled into three
 * client components (the grid, its hook, the note drawer), so a single import
 * of the session RESOLVER would drag the schedule graph (`groupResolve`, the
 * calendar, the week plan) into their bundles for one line of string maths.
 * `sessionKey` therefore lives beside `weekDocId` in `./courses`, and a test
 * pins that this module never reaches for `lib/courses/sessions.ts`.
 */

/**
 * The five states a facilitator can mark. `left-early` is the V3 addition:
 * the completion bar is "attend N sessions IN FULL", and without it somebody
 * who came for ten minutes is recorded identically to somebody who stayed.
 * Ordered attended-most to attended-least, which is the order the register
 * grid cycles through and the order the rollup counts them in.
 */
export type AttendanceStatus =
  | "present"
  | "late"
  | "left-early"
  | "absent"
  | "excused";

export const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  "present",
  "late",
  "left-early",
  "absent",
  "excused",
];

export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: "Present",
  late: "Late",
  "left-early": "Left early",
  absent: "Absent",
  excused: "Excused",
};

export const ATTENDANCE_LIMITS = {
  /**
   * Cap on uids per register. A group is never anywhere near this big, and
   * `courseGroups.MAX_OPEN_MODE_CAPACITY` is pinned to this number because
   * the marking route fails the WHOLE post once a merged map passes it.
   */
  maxRecords: 40,
  notes: 1000,
  /** Per-participant note length. See `participantNotes`. */
  participantNote: 1000,
} as const;

export type CourseAttendanceDoc = {
  /** Firestore doc id: `attendanceDocId(runId, groupId, weekNumber)`. */
  id: string;
  runId: string;
  groupId: string;
  weekNumber: number;
  /**
   * Which of the week's sessions this register is for, 1-based. Defaults to
   * 1, so every register written before the field existed reads correctly.
   * See the module header for why the doc id does not change for 1.
   */
  occurrence: number;
  /** `sessionKey(weekNumber, occurrence)`: the id's own suffix, as a field. */
  sessionKey: string;
  /** Per-member status, keyed by uid. Max 40 entries. */
  records: Record<string, AttendanceStatus>;
  /**
   * Whether the session actually took place. Defaults TRUE, so every register
   * written before this field existed keeps counting.
   *
   * This is not decoration. Without it a cancelled session and an unmarked
   * one are the same empty column, so every ratio built on the registers
   * (the "4 of 6 in full" bar, the unmarked-register follow-up job) is
   * silently wrong in the one case where being wrong matters most: a week
   * nobody could have attended. `held: false` removes the week from the
   * denominator instead of pretending everyone was absent.
   */
  held: boolean;
  /**
   * When the session actually happened — resolved from the group's slot (or
   * that week's override) at marking time. Absent when never resolved.
   */
  sessionAt?: Date;
  /**
   * When the facilitator pressed PUSH ATTENDANCE, and who pressed it. Null /
   * empty while the register is still a DRAFT the facilitator is saving as
   * often as they like during the session.
   *
   * The push is the state change everything downstream hangs off: it locks
   * the register to admin-only edits, recomputes the enrolment rollups, and
   * sends the next-week material reminder. A learner sees their own mark only
   * once this is stamped.
   */
  pushedAt: Date | null;
  pushedByUid: string;
  /** Facilitator note on the session as a whole (plain text). */
  notes?: string;
  /**
   * Post-session notes ABOUT INDIVIDUAL PARTICIPANTS, keyed by uid. Private
   * to reviewers and admins, and never shown to the participant or the
   * cohort.
   *
   * PERSONAL DATA ABOUT A NAMED STUDENT, WRITTEN BY ANOTHER STUDENT. That is
   * why the whole collection stays `read: if false` and why account deletion
   * has to clear this map key by key with a `FieldPath` delete, exactly as it
   * already does for `records`. Deleting the doc would erase the group's
   * marks for that session.
   */
  participantNotes: Record<string, string>;
  markedByUid: string;
  updatedAt?: Date | null;
};

/**
 * Deterministic doc id: one register per (run, group, SESSION), structurally
 * (see module comment). The suffix is `sessionKey`, which sorts in week order
 * in the console and is BYTE-IDENTICAL to the old `weekDocId` suffix for
 * occurrence 1. CONSTRUCT-ONLY: the parts are stored as fields; never parse
 * the id (`slugId`-made ids already contain `__`).
 */
export function attendanceDocId(
  runId: string,
  groupId: string,
  weekNumber: number,
  occurrence: number = 1,
): string {
  return `${runId}__${groupId}__${sessionKey(weekNumber, occurrence)}`;
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

/**
 * Participant notes, capped both in number of keys and in length. Same
 * bounded, deterministic shape as `asRecords` above it, and for the same
 * reason: a hand-edited register must degrade to a smaller register, never to
 * an unbounded payload on a staff surface.
 */
function asParticipantNotes(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const uid of Object.keys(v as Record<string, unknown>).sort()) {
    if (count >= ATTENDANCE_LIMITS.maxRecords) break;
    const note = (v as Record<string, unknown>)[uid];
    if (!uid || typeof note !== "string" || !note) continue;
    out[uid] = note.slice(0, ATTENDANCE_LIMITS.participantNote);
    count += 1;
  }
  return out;
}

export function normalizeCourseAttendance(id: string, data: Raw): CourseAttendanceDoc {
  const weekNumber =
    typeof data.weekNumber === "number" && Number.isFinite(data.weekNumber)
      ? Math.floor(data.weekNumber)
      : 0;
  // Absent means the FIRST session of the week, which is what every register
  // written before the field existed was. Anything below 1 is corrupt input
  // and clamps to 1 rather than minting a register id nothing can address.
  const occurrence =
    typeof data.occurrence === "number" && Number.isFinite(data.occurrence)
      ? Math.max(1, Math.floor(data.occurrence))
      : 1;
  const doc: CourseAttendanceDoc = {
    id,
    runId: str(data.runId),
    groupId: str(data.groupId),
    weekNumber,
    occurrence,
    // DERIVED, never read off the document: the key is a function of the two
    // fields above, and a stored value that disagreed with them would name a
    // different session from the one this register is.
    sessionKey: sessionKey(weekNumber, occurrence),
    records: asRecords(data.records),
    // Absent means HELD: every register written before this field existed
    // recorded a session that happened, and defaulting the other way would
    // retroactively cancel the whole of last term.
    held: data.held !== false,
    pushedAt: tsToDate(data.pushedAt),
    pushedByUid: str(data.pushedByUid),
    participantNotes: asParticipantNotes(data.participantNotes),
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
