import {
  addDaysToKey,
  isValidDateKey,
  londonWallClockToInstant,
  type WeekPlanEntry,
} from "./weekPlan";
import { resolveCalendar, type ResolvedCalendar } from "./groupResolve";
import {
  sessionForWeek,
  type CourseGroupDoc,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import { sessionKey, weekDocId, type CourseRunDoc } from "@/lib/firestore/courses";

/**
 * THE TAUGHT SESSIONS OF ONE GROUP, in order, with the OCCURRENCE dimension.
 *
 * Until this module existed, "a session" and "a taught week" were the same
 * thing everywhere in the codebase: the register was keyed by (run, group,
 * week), `sessionOverrides` and `sessionModes` were keyed by week id, and a
 * group that met twice in a week had no way to say so. PR5 shipped the DATA
 * seam for the second meeting and deliberately stopped there, because the
 * key shape is a birth-pinned decision and the cadence question behind it was
 * an owner's to answer, not a coder's.
 *
 * This module is the RESOLVER half of that seam. It answers one question:
 * which sessions does this group actually hold, and what is each one called.
 * Every consumer that used to derive it by hand (the register's columns,
 * the push, the week lock, the unmarked-register scan) asks it here instead.
 *
 * ── THE ONE INVARIANT THAT MAKES THIS SHIP WITHOUT A MIGRATION ──────────────
 * `sessionKey(n, 1) === weekDocId(n)`, byte for byte. Register ids are
 * `{runId}__{groupId}__{sessionKey}` (see `attendanceDocId`), so every
 * register already written keeps its id, `accountDeletion`'s `documentId()`
 * scan keeps working, and nothing anywhere has to move. Occurrence 2 and up
 * get a `-2`, `-3` suffix, which is a doc id no week has ever produced.
 *
 * A HYPHEN, and not `#` or `.`: the key is spliced into Firestore document
 * ids (registers, scheduler markers, the unmarked-register task) and into URL
 * query values, and a hyphen needs no escaping in either. `__` is already the
 * house id separator and is deliberately not reused inside one component.
 *
 * ── THE SECOND SLOT IS READ, NOT ASSUMED ────────────────────────────────────
 * A group's second weekly slot lives on `courseGroups.extraSession`, which
 * `normalizeCourseGroup` does NOT yet produce: that field is still blocked on
 * the pre-course cadence decision, and adding it is a rules change this PR
 * does not carry. So `resolveSessions` reads it OPTIONALLY. Today every
 * caller passes a normalised group, every group resolves to exactly one
 * session per taught week, and every register id is unchanged. The moment the
 * field lands, this module already knows what to do with it, and its tests
 * already say what that is.
 *
 * ── WHAT IS DELIBERATELY NOT RESOLVED FOR OCCURRENCE 2 ──────────────────────
 * `sessionOverrides` and `sessionModes` are `Record<weekId, ...>` with no
 * occurrence component, and `sessionModes` is pinned FLAT in firestore.rules
 * precisely to keep that pin one comparison. So a per-week room move or
 * virtual switch applies to the week's FIRST session only, and the second
 * carries the group's standing `extraSession` unmodified. That is a stated
 * limitation of the current key shape rather than a resolution rule: when the
 * maps are re-keyed, this function is where the second lookup goes.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 * No reads, no clock unless one is passed. `resolveCalendar` is the same
 * group-first resolution every schedule consumer uses, so a group pacing
 * itself apart from its run resolves its OWN dates here, exactly as its
 * members see them.
 */

/** Days in one week-plan slot, the plan's own constant, restated locally. */
const DAYS_PER_WEEK = 7;

/** Matches the rules' `weekNumber` bounds and `maxWeekPlanEntries`. */
const MAX_WEEK_NUMBER = 60;

/**
 * A group document as this module needs it: the normalised shape, plus the
 * second slot it does not carry yet. See the module header.
 */
export type SessionGroup = CourseGroupDoc & {
  extraSession?: GroupSession | null;
};

export type ResolvedSession = {
  /** The taught week this session belongs to. */
  weekNumber: number;
  /** `weekDocId(weekNumber)`, the ADDRESSING id, never the plan's own. */
  weekId: string;
  /** 1-based. 1 is the group's standing slot; 2 is `extraSession`. */
  occurrence: number;
  /** `sessionKey(weekNumber, occurrence)`. Keys the register and the markers. */
  sessionKey: string;
  /** The civil date this week's 7-day slot began. */
  slotStartKey: string;
  /**
   * The civil date this session falls on, or "" when the calendar cannot
   * resolve one (no start date, malformed plan, no weekday set). Absent is a
   * real state and must never be faked: a register stamped with a wrong date
   * is worse than one with no date.
   */
  dateKey: string;
  /** The slot itself, overrides applied for occurrence 1. */
  session: GroupSession;
};

/**
 * The key one session is known by, everywhere: the register's doc id suffix,
 * the unmarked-register marker, the follow-up task id, the rollup's
 * `lastPushedSessionKey`.
 *
 * OCCURRENCE 1 IS `weekDocId(n)` EXACTLY. See the module header for why that
 * is the invariant the whole seam rests on.
 *
 * DEFINED IN `firestore/courses.ts`, beside `weekDocId`, and re-exported here
 * so every caller that thinks in sessions still reads it off this module.
 * `courseAttendance.ts` builds register ids from it and is imported by three
 * client components; taking it from here would pull the whole resolver graph
 * below into their bundles for one line of string maths.
 */
export { sessionKey };

/**
 * The taught weeks of a plan, in PLAN ORDER, with the index of each entry in
 * the plan kept, the index is what dates the slot, and it counts breaks.
 *
 * Defended against a corrupt plan exactly as the register route is:
 * `sanitizeWeekPlan` checks types but neither the range nor the uniqueness of
 * `weekNumber`, and a week number out of range would build a doc id no
 * document can live at. Integers in range only; first entry wins a duplicate.
 */
function taughtWeeksOf(
  weekPlan: WeekPlanEntry[],
): Array<{ weekNumber: number; index: number }> {
  const out: Array<{ weekNumber: number; index: number }> = [];
  const seen = new Set<number>();
  weekPlan.forEach((entry, index) => {
    if (entry.kind !== "week") return;
    const n = entry.weekNumber;
    if (!Number.isInteger(n) || n < 1 || n > MAX_WEEK_NUMBER || seen.has(n)) return;
    seen.add(n);
    out.push({ weekNumber: n, index });
  });
  return out;
}

/**
 * The civil date a weekly slot's session falls on: the first day at or after
 * the slot's start whose weekday matches the session's.
 *
 * Returns "" on anything the week maths would reject, which degrades the
 * session to "no date" rather than throwing mid-render. Parsed at midnight
 * UTC, the convention `weekPlan.ts` parses every date key with, so no zone
 * offset enters the arithmetic and `getUTCDay()` is the London weekday.
 */
function sessionDateKey(slotStartKey: string, weekday: number): string {
  if (!isValidDateKey(slotStartKey)) return "";
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return "";
  const slotWeekday = new Date(`${slotStartKey}T00:00:00Z`).getUTCDay();
  return addDaysToKey(slotStartKey, (weekday - slotWeekday + DAYS_PER_WEEK) % DAYS_PER_WEEK);
}

/** A slot with a real weekday and a real start time is one we can date. */
function isMeetable(session: GroupSession | null | undefined): session is GroupSession {
  return Boolean(
    session &&
      Number.isInteger(session.weekday) &&
      session.weekday >= 0 &&
      session.weekday <= 6 &&
      /^([01]\d|2[0-3]):([0-5]\d)$/.test(session.startTimeLocal),
  );
}

/**
 * Every session this group holds, in order: week by week, and within a week,
 * occurrence by occurrence.
 *
 * The calendar is the GROUP's own (`resolveCalendar`), so a group that
 * re-paced itself resolves its own dates. Pass one explicitly when the caller
 * has already resolved it, every consumer here resolves it once and reuses
 * it, because a second resolution is a second chance to disagree.
 *
 * A group with no usable start date still yields its sessions, each with an
 * empty `dateKey`: the register's columns are the taught weeks whether or not
 * the run has been dated yet, and a half-authored run is a legitimate state.
 */
export function resolveSessions(
  run: CourseRunDoc,
  group: SessionGroup | null,
  calendar: ResolvedCalendar = resolveCalendar(run, group),
): ResolvedSession[] {
  const out: ResolvedSession[] = [];
  const datable = isValidDateKey(calendar.startDate);

  for (const { weekNumber, index } of taughtWeeksOf(calendar.weekPlan)) {
    const weekId = weekDocId(weekNumber);
    const slotStartKey = datable
      ? addDaysToKey(calendar.startDate, index * DAYS_PER_WEEK)
      : "";

    // Occurrence 1, the standing slot, with this week's override applied.
    // `sessionForWeek` resolves by the NUMBER-derived week id, which is what
    // every member-facing surface resolves by; a renumbered plan can
    // legitimately have the entry's own `weekId` disagree.
    const first = group
      ? sessionForWeek(group, weekId)
      : ({
          weekday: -1,
          startTimeLocal: "",
          durationMinutes: 0,
          location: "",
          meetingUrl: null,
          notes: "",
        } as GroupSession);
    out.push({
      weekNumber,
      weekId,
      occurrence: 1,
      sessionKey: sessionKey(weekNumber, 1),
      slotStartKey,
      dateKey: slotStartKey && isMeetable(first) ? sessionDateKey(slotStartKey, first.weekday) : "",
      session: first,
    });

    // Occurrence 2, the group's second standing slot, when it has one. NO
    // override lookup: the override maps have no occurrence dimension (module
    // header). A group whose second slot is half-authored simply does not
    // hold a second session, which is the same answer the register gives.
    const extra = group?.extraSession ?? null;
    if (isMeetable(extra)) {
      out.push({
        weekNumber,
        weekId,
        occurrence: 2,
        sessionKey: sessionKey(weekNumber, 2),
        slotStartKey,
        dateKey: slotStartKey ? sessionDateKey(slotStartKey, extra.weekday) : "",
        session: extra,
      });
    }
  }

  return out;
}

/**
 * When one resolved session starts and ends, as instants.
 *
 * `null` on either half whenever the session has no resolvable date, which
 * is a documented state, not a failure. Callers that need an instant (the
 * unmarked-register scan, "has this session finished yet") must treat a null
 * as "cannot say", never as "now".
 */
export function sessionInstants(session: ResolvedSession): {
  startsAt: Date | null;
  endsAt: Date | null;
} {
  if (!session.dateKey || !isMeetable(session.session)) {
    return { startsAt: null, endsAt: null };
  }
  let startsAt: Date | null = null;
  try {
    startsAt = londonWallClockToInstant(session.dateKey, session.session.startTimeLocal);
  } catch {
    // A date key that survived the guards. No instant is the honest answer.
    return { startsAt: null, endsAt: null };
  }
  const minutes = session.session.durationMinutes;
  const endsAt =
    Number.isFinite(minutes) && minutes > 0
      ? new Date(startsAt.getTime() + minutes * 60_000)
      : startsAt;
  return { startsAt, endsAt };
}

/**
 * The session a (week, occurrence) pair names, or null when this group holds
 * no such session. The one lookup every write path uses before it touches a
 * register: a mark for a session the group does not hold must be refused, not
 * stored under an id nothing will ever read again.
 */
export function findSession(
  sessions: ResolvedSession[],
  weekNumber: number,
  occurrence: number,
): ResolvedSession | null {
  return (
    sessions.find((s) => s.weekNumber === weekNumber && s.occurrence === occurrence) ??
    null
  );
}
