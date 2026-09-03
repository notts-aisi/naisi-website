import {
  ATTENDANCE_STATUSES,
  type AttendanceStatus,
} from "@/lib/firestore/courseAttendance";
import type { ResolvedSession } from "./sessions";

/**
 * ONE MEMBER'S OWN ATTENDANCE, projected out of their group's registers.
 *
 * A register is a whole room's record: every classmate's mark, and the
 * facilitator's private post-session notes ABOUT those classmates. It is
 * `read/write: if false` in the rules for that reason, and it is not
 * something a learner-facing payload may ever carry through by accident.
 *
 * So this function is a PROJECTION, not a filter, and the distinction is the
 * whole point. It never spreads a register, never deletes keys off a copy of
 * one, never passes a normalised register doc along. It reads exactly four
 * facts out of each one and builds a new object from them:
 *
 *   the session it belongs to, whether that session was held, its date, and
 *   THIS uid's mark.
 *
 * Nothing else can leak, because nothing else is ever read. A field added to
 * `courseAttendance` next term travels nowhere by default, which is the
 * opposite of what a delete-the-sensitive-keys approach guarantees.
 *
 * ── PUSHED ONLY, BY CONSTRUCTION ────────────────────────────────────────────
 * A register with no `pushedAt` is a DRAFT the facilitator is still saving
 * during the session, and it is dropped here before anything is read off it.
 * That is the same rule the rollup's first denominator rule states, applied at
 * the other end of the pipe: half a session's marks would show a learner an
 * absence for a session they are sitting in.
 *
 * A learner therefore cannot see a mark before their facilitator has pressed
 * PUSH ATTENDANCE, and cannot see one at all for a session the facilitator
 * never pushed. Both are silence rather than a wrong answer.
 *
 * ── AN UNMARKED CELL IN A PUSHED REGISTER ───────────────────────────────────
 * Left as `null` here rather than resolved to "absent". The ROLLUP counts it
 * as an absence (its rule 4, and the facilitator pressing push is what makes
 * that fair), but the per-session list is a record of what was written down,
 * and a page can then say "not marked" instead of accusing someone of missing
 * a session nobody recorded. The two live side by side on the payload and
 * disagreeing about this is deliberate.
 *
 * PURE. No reads, no clock. The caller resolves the sessions and hands over
 * the raw register data it fetched.
 */

export type OwnAttendanceSession = {
  /** `sessionKey(weekNumber, occurrence)`. */
  sessionKey: string;
  weekNumber: number;
  /** 1-based; 2 and up are the week's later sessions. */
  occurrence: number;
  /** Civil date "YYYY-MM-DD", empty when the calendar cannot date it. */
  dateKey: string;
  /** False = the session was cancelled and counts in no denominator. */
  held: boolean;
  /** This member's mark, or null when the pushed register did not name them. */
  status: AttendanceStatus | null;
};

/**
 * A register as this projection needs it: the RAW document data, keyed by the
 * session key its id was built from.
 *
 * Raw rather than normalised on purpose. `normalizeCourseAttendance` produces
 * `records` and `participantNotes` for the WHOLE room, and handing that object
 * to a member-facing projection would put the thing being guarded against
 * inside the guard.
 */
export type RawRegisters = ReadonlyMap<string, Record<string, unknown>>;

/** True for a Firestore Timestamp or a Date; the register's push stamp. */
function isPushed(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const ts = value as { toDate?: () => Date } | null | undefined;
  return typeof ts?.toDate === "function";
}

function statusOf(records: unknown, uid: string): AttendanceStatus | null {
  if (!records || typeof records !== "object") return null;
  const mark = (records as Record<string, unknown>)[uid];
  return ATTENDANCE_STATUSES.includes(mark as AttendanceStatus)
    ? (mark as AttendanceStatus)
    : null;
}

/**
 * THE SESSIONS A MID-RUN JOINER OWNS: their group's schedule from the week
 * they joined onwards.
 *
 * `joinedWeekNumber` is the same floor the attendance push and the progress
 * grid already respect (see `courseEnrolments`): somebody added in week 4 was
 * not absent in weeks 1 to 3, they were not there to be marked. Without this
 * the per-session list hands them three "Not marked" rows for a room they had
 * not joined, directly beside a rollup whose denominator starts at week 4.
 *
 * Applied BEFORE the caller's read cap so the register fetch is bounded from
 * the join week too, rather than spending its budget on sessions that are
 * about to be dropped.
 *
 * A missing or garbled floor reads as week 1, the same default the normaliser
 * takes, so a joiner can only ever be shown MORE of their own record.
 */
export function sessionsFromJoinWeek(
  sessions: readonly ResolvedSession[],
  joinedWeekNumber: number,
): ResolvedSession[] {
  const from = Number.isFinite(joinedWeekNumber)
    ? Math.max(1, Math.floor(joinedWeekNumber))
    : 1;
  return sessions.filter((session) => session.weekNumber >= from);
}

/**
 * This member's own row, session by session, in schedule order.
 *
 * Sessions with no pushed register are OMITTED rather than emitted empty: an
 * unpushed register and a session that has not happened yet are the same fact
 * to a learner (nothing has been recorded), and a list of blank rows stretching
 * to the end of term reads as a record of absences.
 */
export function ownAttendanceSessions(
  uid: string,
  sessions: readonly ResolvedSession[],
  registers: RawRegisters,
): OwnAttendanceSession[] {
  if (!uid) return [];
  const out: OwnAttendanceSession[] = [];
  for (const session of sessions) {
    const raw = registers.get(session.sessionKey);
    if (!raw || !isPushed(raw.pushedAt)) continue;
    out.push({
      sessionKey: session.sessionKey,
      weekNumber: session.weekNumber,
      occurrence: session.occurrence,
      dateKey: session.dateKey,
      // Absent means HELD, the same default `normalizeCourseAttendance` takes:
      // every register written before the field existed recorded a session
      // that happened.
      held: raw.held !== false,
      status: statusOf(raw.records, uid),
    });
  }
  return out;
}
