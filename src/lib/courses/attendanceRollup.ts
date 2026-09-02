import {
  EMPTY_ATTENDANCE_ROLLUP,
  type EnrolmentAttendanceRollup,
} from "@/lib/firestore/courseEnrolments";
import type { AttendanceStatus } from "@/lib/firestore/courseAttendance";

/**
 * THE ATTENDANCE ROLLUP, RECOMPUTED FROM SOURCE.
 *
 * `courseEnrolments.attendance` is the number a reviewer reads, a certificate
 * is issued against and a completion bar is judged by. It is a MIRROR of the
 * group's pushed registers and nothing else, and this function is the only
 * thing that builds it.
 *
 * ── FULL RECOMPUTE, NEVER A DELTA ───────────────────────────────────────────
 * The push hands this function EVERY pushed register of the member's group and
 * takes the answer whole. It never adds one to a counter. That is the direct
 * lesson from `applicationCounts`, which moves only as relative increments,
 * has no recount pass anywhere, and is therefore unreconcilable once it
 * drifts. A mirror that can be rebuilt from its source at any time cannot
 * drift at all: an admin editing a locked register, a re-push of the same
 * session, and a first push all run the same arithmetic over the same rows.
 *
 * ── THE FOUR RULES THAT DECIDE THE DENOMINATOR ──────────────────────────────
 *  1. UNPUSHED REGISTERS DO NOT COUNT. A register a facilitator is still
 *     saving during the session is a draft, and half a session's marks would
 *     read as a room full of absences.
 *  2. `held: false` REMOVES THE SESSION ENTIRELY. A cancelled session is not
 *     a session anybody missed. Without this a cancelled week and an unmarked
 *     one are the same empty column, and every ratio built on the pair is
 *     silently wrong in the one case where being wrong matters most.
 *  3. SESSIONS BEFORE THE MEMBER JOINED DO NOT COUNT. `joinedWeekNumber` is a
 *     floor the register route already enforces on writes; it is enforced
 *     again here so a mark stranded by an edited join week cannot deflate
 *     somebody's record.
 *  4. AN UNMARKED PERSON IN A PUSHED, HELD REGISTER IS ABSENT. Once the
 *     facilitator has pressed push they have said the register is finished,
 *     and "nobody wrote anything down" is exactly what an absence looks like
 *     from the room. Before the push the same blank means "not marked yet",
 *     which is why rule 1 comes first.
 *
 * `excused` is counted AND left in `sessionsHeld`: a reviewer needs to see
 * both "six sessions were held" and "one of them was excused", and a
 * denominator that quietly shrank per person would make two members' figures
 * incomparable. Whether an excused session counts against a completion bar is
 * the reviewer's judgement, and the rollup gives them the parts to make it.
 *
 * PURE. No reads, no clock beyond the `now` the caller passes, so the whole
 * thing is testable as arithmetic.
 */

/** One register, reduced to what the rollup needs to know about ONE member. */
export type RegisterFact = {
  /** `sessionKey(weekNumber, occurrence)`. Stamped as `lastPushedSessionKey`. */
  sessionKey: string;
  weekNumber: number;
  /** 1-based. Orders two sessions inside one week. */
  occurrence: number;
  /** False = the session did not happen. Removed from every denominator. */
  held: boolean;
  /** Null while the register is still a draft. */
  pushedAt: Date | null;
  /** This member's mark, or null when the register does not name them. */
  status: AttendanceStatus | null;
};

export type RollupInput = {
  /** The cohort week this member joined at. A floor, never a filter on marks. */
  joinedWeekNumber: number;
  /** Stamped as `lastComputedAt`. Passed so the caller's clock is the only one. */
  now: Date;
};

/**
 * Rebuild one member's rollup from their group's registers.
 *
 * Order-independent by construction, the caller may hand these rows over in
 * whatever order Firestore returned them, except for `lastPushedSessionKey`,
 * which is resolved by sorting on (weekNumber, occurrence). That is the
 * SCHEDULE's order rather than the order the pushes happened in, deliberately:
 * a facilitator catching up on a missed week 2 after pushing week 3 has not
 * moved the cohort backwards, and the key names how far through the course the
 * figures reach.
 */
export function recomputeRollup(
  registers: RegisterFact[],
  input: RollupInput,
): EnrolmentAttendanceRollup {
  const joined = Number.isFinite(input.joinedWeekNumber)
    ? Math.max(1, Math.floor(input.joinedWeekNumber))
    : 1;

  const counted = registers
    .filter((r) => r.pushedAt !== null && r.held && r.weekNumber >= joined)
    .sort((a, b) => a.weekNumber - b.weekNumber || a.occurrence - b.occurrence);

  const rollup: EnrolmentAttendanceRollup = {
    ...EMPTY_ATTENDANCE_ROLLUP,
    lastComputedAt: input.now,
  };

  for (const register of counted) {
    rollup.sessionsHeld += 1;
    switch (register.status) {
      case "present":
        rollup.attendedInFull += 1;
        break;
      case "late":
        rollup.late += 1;
        break;
      case "left-early":
        rollup.leftEarly += 1;
        break;
      case "excused":
        rollup.excused += 1;
        break;
      // An explicit absence and an unmarked cell in a PUSHED register are the
      // same fact, see rule 4 in the module header.
      case "absent":
      default:
        rollup.absent += 1;
        break;
    }
  }

  const last = counted[counted.length - 1];
  rollup.lastPushedSessionKey = last ? last.sessionKey : null;
  return rollup;
}
