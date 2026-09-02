import { isValidDateKey, type WeekPlanEntry } from "../courses/weekPlan";
import {
  normalizeCourseWeek,
  sanitizeWeekPlan,
  type CourseWeekDoc,
} from "./courses";

/**
 * `courseGroups/{id}` (top-level) — the small facilitated groups inside a
 * course run. Doc id = `slugId(runLabel + name)`; `runId`/`courseId` are
 * stored as queryable fields.
 *
 * Groups carry the weekly session slot and the meeting link, so READ access
 * is restricted (admin / draft / approve holders + the group's facilitators);
 * members get their own group's card via a server route. `facilitatorUids`
 * and `memberCount` are server-owned (routes only, pinned in rules) — the
 * member count is maintained by the allocation transaction so it can never
 * drift from the enrolment docs it summarises.
 *
 * ## Per-group autonomy (v2 decision 4 — COPY-ON-WRITE)
 *
 * A group reads its run's canonical weeks and calendar until its facilitator
 * first personalises them:
 *
 *  - CONTENT forks per week into `courseGroups/{groupId}/weeks/{wNN}`
 *    (`GroupWeekDoc` below) via the fork route. An unforked week keeps
 *    tracking the run canonical, so admin refinements propagate right up to
 *    the moment a facilitator makes the week their own. Nothing ever merges
 *    back.
 *  - CALENDAR overrides live on this doc as `paceStartDate`/`paceWeekPlan`,
 *    both `null` (= track the run) until the pace route sets them.
 *
 * Every consumer resolves group-first through `src/lib/courses/groupResolve.ts`
 * — NOTHING resolves group content ad hoc.
 *
 * `paceStartDate`, `paceWeekPlan` and the `sessionModes` map (the stored form
 * of every override's `mode` — see `GroupSessionMode`) are SERVER-OWNED like
 * `memberCount` (pinned in rules for the non-admin client lanes; the
 * pace/session routes are the writers). The rest of the session fields stay
 * facilitator-editable client-direct, exactly as before.
 */

/*
 * V3 seam: session occurrence dimension lands when the pre-course cadence is
 * confirmed; register ids stay byte-identical for occurrence 1.
 *
 * `sessionOverrides` and `sessionModes` are both keyed by WEEK ID with no
 * occurrence component, so a group meeting twice in one week cannot currently
 * move, virtualise or room-notice one of its two sessions. Adding
 * `extraSession` (or an explicit `sessionDates` list, the pre-committed
 * fallback for an irregular rhythm) means changing that key shape, which is a
 * birth-pinned data decision and therefore deliberately NOT taken here. The
 * matching note in `courseAttendance.ts` is the other half. Start at both.
 */

export type GroupSession = {
  /** 0 = Sunday .. 6 = Saturday (JS `Date.getDay()` convention). */
  weekday: number;
  /** Wall-clock start in Europe/London, "HH:MM" 24h (e.g. "18:00"). */
  startTimeLocal: string;
  durationMinutes: number;
  location: string;
  /** Video-call link; null when the group meets in person only. */
  meetingUrl: string | null;
  notes: string;
};

/**
 * How one (group, week) session happens (v2 decision 7). Binary and
 * facilitator-set — but through the session ROUTE, never client-direct (see
 * the module comment): "virtual" surfaces the meeting link and suppresses the
 * location, "in-person" the reverse. Absent = legacy behaviour (both shown).
 *
 * STORAGE vs RESOLVED SHAPE, deliberately different: on the WIRE the modes
 * live in a flat, server-owned top-level map `sessionModes: { w03: "virtual" }`
 * — pinnable in rules with ONE comparison, exactly like `memberCount`. (The
 * first cut stored `mode` inside each `sessionOverrides` value; pinning a
 * nested field across an arbitrary-keyed map forced a 60-key enumeration
 * that blew Firestore's 1000-expression evaluation budget and denied every
 * legitimate group write.) `normalizeCourseGroup` FOLDS the map into
 * `sessionOverrides[weekId].mode`, so every consumer still reads the one
 * resolved shape — and a `mode` smuggled INTO a stored override value by a
 * client write is dead data the normaliser never reads.
 */
export type GroupSessionMode = "in-person" | "virtual";

export const GROUP_SESSION_MODES: GroupSessionMode[] = ["in-person", "virtual"];

/**
 * One week's deviation from the recurring slot, AS RESOLVED: the partial
 * session fields a facilitator may edit client-direct, plus the server-owned
 * `mode` folded in from `sessionModes` (see `GroupSessionMode`).
 */
export type GroupSessionOverride = Partial<GroupSession> & {
  /** SERVER-OWNED — folded from `sessionModes` at normalise time. */
  mode?: GroupSessionMode;
};

/**
 * One facilitator's appointment to this group: who appointed them, when, and
 * whether the facilitator has agreed to it yet.
 *
 * Keyed by uid alongside `facilitatorUids` rather than replacing it, because
 * `facilitatorUids` is what every rule, query and route already reads and an
 * array is what Firestore can index on. This map is the RECORD of how each of
 * those uids got there: decisions.md asks for facilitator appointments to be
 * recorded, and "the array contains them" answers neither who nor when.
 *
 * Routes-only and birth-pinned empty, exactly like `facilitatorUids` itself:
 * a group that could be born carrying appointments nobody issued would make
 * the record worth less than no record.
 */
export type FacilitatorAppointment = {
  at: Date | null;
  byUid: string;
  byName: string;
  /**
   * When the facilitator confirmed. Null = appointed but not yet agreed,
   * which is a real state during the weeks-3-to-4 training window and not an
   * error.
   */
  agreedAt: Date | null;
};

export type CourseGroupDoc = {
  /** Firestore doc id: `slugId(runLabel + name)`. */
  id: string;
  runId: string;
  courseId: string;
  name: string;
  /** Server-owned (routes only, pinned in rules). Max 5. */
  facilitatorUids: string[];
  /**
   * Appointment provenance for the uids above (see `FacilitatorAppointment`).
   * Server-owned, birth-pinned empty, capped at `maxFacilitatorAppointments`.
   */
  facilitatorAppointments: Record<string, FacilitatorAppointment>;
  /**
   * The stream this group teaches, or null when it is open to every stream.
   *
   * SERVER-OWNED, birth-pinned null, pinned on update, the same correction
   * as `courseRuns.streams`, and for the same reason: the enrol route decides
   * who may pick this group by comparing their stream against this field,
   * while `courseEnrolments.streamId` is `allow write: if false`. A
   * facilitator retagging their own group client-direct would strand rows in
   * a collection the client cannot repair.
   */
  streamId: string | null;
  /**
   * Allocation cap; null = uncapped.
   *
   * REQUIRED, and at most `MAX_OPEN_MODE_CAPACITY`, for a group belonging to
   * an OPEN-mode run; see `groupCapacityError`. Still nullable in the type
   * because the admissions runs that predate open mode legitimately carry
   * null, and because this doc alone cannot tell which kind of run it is on.
   */
  capacity: number | null;
  /** Server-owned counter, maintained by the allocation transaction. */
  memberCount: number;
  /** The recurring weekly slot. */
  session: GroupSession;
  /**
   * Per-week deviations from the recurring slot, keyed by week doc id
   * ("w03"). A partial: only the fields that differ that week are stored
   * (e.g. just a `location` change, or a moved `startTimeLocal`). Capped at
   * 20 keys so a group doc can't grow unboundedly. Values may carry the
   * server-owned `mode` (see `GroupSessionOverride`).
   */
  sessionOverrides: Record<string, GroupSessionOverride>;
  /**
   * CALENDAR COPY-ON-WRITE (v2 decision 4). `null` = track the run's
   * `startDate`; a "YYYY-MM-DD" civil date when the facilitator has re-paced
   * this group. SERVER-OWNED — written only by the pace route, pinned in
   * rules for non-admin client lanes; stored as a REAL null when tracking so
   * the rules pin (`get(field, null)`) compares equal whether the field is
   * absent (legacy doc) or cleared.
   */
  paceStartDate: string | null;
  /**
   * `null` = track the run's `weekPlan`; a full plan when overridden. Same
   * ownership, storage and null semantics as `paceStartDate`. Interpreted
   * ONLY through `resolveCalendar()` in `src/lib/courses/groupResolve.ts`.
   */
  paceWeekPlan: WeekPlanEntry[] | null;
  archived: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

/**
 * Field budgets for group editing. Keep in sync with firestore.rules — the
 * session fields are client-editable by facilitators/editors, so the rules
 * enforce these caps as the security boundary.
 */
export const GROUP_FIELD_LIMITS = {
  name: 80,
  location: 200,
  meetingUrl: 300,
  notes: 500,
  maxDurationMinutes: 480,
  maxFacilitators: 5,
  maxSessionOverrides: 20,
  /** One appointment record per facilitator slot; see `maxFacilitators`. */
  maxFacilitatorAppointments: 5,
  appointedByName: 120,
} as const;

/**
 * The hard ceiling on an OPEN-mode group's capacity, and it is not a taste
 * decision: `attendance/route.ts` throws `RegisterFullError` on the MERGED
 * records map for the WHOLE POST once a register passes
 * `ATTENDANCE_LIMITS.maxRecords` keys. So an uncapped "everyone gets a place"
 * group does not merely leave its 41st member unmarked: it makes a bulk
 * "rest present" fail for everyone in the room, and zeroes the completion
 * signal the pre-course bar is computed from.
 *
 * Kept as its own named constant rather than an inline 40 so the two numbers
 * are visibly the same number.
 */
export const MAX_OPEN_MODE_CAPACITY = 40;

/**
 * Why this group's capacity is not acceptable for the given enrolment mode,
 * or null when it is. Human sentences: the group editor shows them verbatim.
 *
 * NOT part of `normalizeCourseGroup`, and it cannot be: the normaliser is
 * handed one group document and the constraint depends on the parent RUN's
 * `enrolMode`. Callers that know both (the group routes, the group editor,
 * the enrol transaction) call this; `groupContentOk()` in firestore.rules
 * expresses as much of it as a rule can reach.
 */
export function groupCapacityError(
  capacity: number | null,
  enrolMode: "admissions" | "open",
): string | null {
  if (capacity !== null) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      return "Capacity must be a whole number of places, or left unset.";
    }
    if (capacity > MAX_OPEN_MODE_CAPACITY) {
      return `A group can hold at most ${MAX_OPEN_MODE_CAPACITY} people, because that is the ceiling on one session's register.`;
    }
    return null;
  }
  if (enrolMode === "open") {
    return `Groups on an open-enrolment run need a capacity, at most ${MAX_OPEN_MODE_CAPACITY}. Without one the group can fill past the size a register can hold, and marking attendance then fails for everybody in it.`;
  }
  return null;
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function asUidList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const u of v) {
    if (typeof u === "string" && u) seen.add(u);
  }
  return Array.from(seen);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** "HH:MM" 24h or empty string — never a garbled time. */
function asTimeLocal(v: unknown): string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : "";
}

function asWeekday(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.min(6, Math.max(0, Math.round(v)));
}

function asDurationMinutes(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(GROUP_FIELD_LIMITS.maxDurationMinutes, Math.round(v));
}

function normalizeSession(v: unknown): GroupSession {
  const raw = (v ?? {}) as Raw;
  return {
    weekday: asWeekday(raw.weekday),
    startTimeLocal: asTimeLocal(raw.startTimeLocal),
    durationMinutes: asDurationMinutes(raw.durationMinutes),
    location: str(raw.location, GROUP_FIELD_LIMITS.location),
    meetingUrl:
      typeof raw.meetingUrl === "string" && raw.meetingUrl
        ? raw.meetingUrl.slice(0, GROUP_FIELD_LIMITS.meetingUrl)
        : null,
    notes: str(raw.notes, GROUP_FIELD_LIMITS.notes),
  };
}

/**
 * Overrides are partial by design — normalise keeps only the session fields
 * actually present (a week that just moves rooms stores only `location`).
 * A `mode` key inside a STORED override value is deliberately ignored: modes
 * are read exclusively from the server-owned `sessionModes` map (see
 * `GroupSessionMode`), so a client write cannot smuggle one in here.
 */
function normalizeSessionOverride(v: unknown): GroupSessionOverride {
  const raw = (v ?? {}) as Raw;
  const out: GroupSessionOverride = {};
  if (raw.weekday !== undefined) out.weekday = asWeekday(raw.weekday);
  if (raw.startTimeLocal !== undefined) {
    out.startTimeLocal = asTimeLocal(raw.startTimeLocal);
  }
  if (raw.durationMinutes !== undefined) {
    out.durationMinutes = asDurationMinutes(raw.durationMinutes);
  }
  if (raw.location !== undefined) {
    out.location = str(raw.location, GROUP_FIELD_LIMITS.location);
  }
  if (raw.meetingUrl !== undefined) {
    out.meetingUrl =
      typeof raw.meetingUrl === "string" && raw.meetingUrl
        ? raw.meetingUrl.slice(0, GROUP_FIELD_LIMITS.meetingUrl)
        : null;
  }
  if (raw.notes !== undefined) out.notes = str(raw.notes, GROUP_FIELD_LIMITS.notes);
  return out;
}

function normalizeSessionOverrides(
  v: unknown,
): Record<string, GroupSessionOverride> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, GroupSessionOverride> = {};
  let count = 0;
  for (const [weekId, value] of Object.entries(v as Record<string, unknown>)) {
    if (count >= GROUP_FIELD_LIMITS.maxSessionOverrides) break;
    if (!value || typeof value !== "object") continue;
    out[weekId] = normalizeSessionOverride(value);
    count += 1;
  }
  return out;
}

/** Week doc ids are "w01".."w60" — a mode under any other key is unreadable. */
const WEEK_ID_SHAPE = /^w[0-9][0-9]$/;

/**
 * The server-owned mode map, folded onto the overrides (see
 * `GroupSessionMode`). Only legal values under addressable week ids survive;
 * an entry for a week with no other override CREATES the override, because
 * "meets online, same room field untouched" is a normal state.
 */
function foldSessionModes(
  overrides: Record<string, GroupSessionOverride>,
  v: unknown,
): Record<string, GroupSessionOverride> {
  if (!v || typeof v !== "object") return overrides;
  for (const [weekId, mode] of Object.entries(v as Record<string, unknown>)) {
    if (!WEEK_ID_SHAPE.test(weekId)) continue;
    if (!GROUP_SESSION_MODES.includes(mode as GroupSessionMode)) continue;
    overrides[weekId] = { ...overrides[weekId], mode: mode as GroupSessionMode };
  }
  return overrides;
}

/**
 * The effective session for a given week: the recurring slot with that week's
 * override (if any) laid over it. Pure derivation — nothing stores the merged
 * result, so a corrected override is instantly right everywhere.
 */
export function sessionForWeek(group: CourseGroupDoc, weekId: string): GroupSession {
  const override = group.sessionOverrides[weekId];
  if (!override) return group.session;
  // `mode` is deliberately not part of GroupSession — strip it so the merged
  // slot stays the shape every existing consumer expects; the mode has its
  // own reader below.
  const { mode: _mode, ...sessionFields } = override;
  return { ...group.session, ...sessionFields };
}

/**
 * The effective virtual/in-person mode for a (group, week), or `null` when
 * the facilitator has never set one (legacy behaviour: show whatever the
 * session carries). Same `weekDocId(n)` addressing doctrine as
 * `sessionForWeek` — never a plan entry's own `weekId`.
 */
export function sessionModeForWeek(
  group: CourseGroupDoc,
  weekId: string,
): GroupSessionMode | null {
  return group.sessionOverrides[weekId]?.mode ?? null;
}

/**
 * EVERY week's mode for this group, flat — `sessionModeForWeek` for a surface
 * that cannot name its week in advance.
 *
 * WHY A MAP AND NOT ONE RESOLVED MODE. A payload can only resolve one week,
 * and the week page is opened on ANY week: a card resolved for the CURRENT
 * week but dated to the VIEWED one said "Online this week" over week 3's
 * evening because week 5 had been flipped, and hid week 3's room to do it.
 * The map lets each surface answer for the week it is actually drawing —
 * `WeekView` the viewed week, the run home and the group page the current one.
 *
 * SAFE TO SEND TO A MEMBER, and that is why it may travel whole: a mode is a
 * display fact of the same tier as `sessionLabel` — no PII, no meeting link
 * (`meetingUrl` keeps its own gate), and it says nothing about any other group.
 *
 * BOUNDED by `GROUP_FIELD_LIMITS.maxSessionOverrides` and taken in week-id
 * order, so a group doc that somehow carries more modes than the cap (the fold
 * can create an override that `normalizeSessionOverrides` never counted)
 * truncates deterministically instead of shipping an unbounded map.
 */
export function sessionModesOf(
  group: CourseGroupDoc,
): Record<string, GroupSessionMode> {
  const out: Record<string, GroupSessionMode> = {};
  let count = 0;
  for (const weekId of Object.keys(group.sessionOverrides).sort()) {
    if (count >= GROUP_FIELD_LIMITS.maxSessionOverrides) break;
    const mode = group.sessionOverrides[weekId]?.mode;
    if (!mode) continue;
    out[weekId] = mode;
    count += 1;
  }
  return out;
}

/**
 * Appointment records, capped and taken in uid order so a group doc carrying
 * more than the cap truncates deterministically rather than shipping an
 * unbounded map (the `sessionModesOf` doctrine).
 */
function normalizeFacilitatorAppointments(
  v: unknown,
): Record<string, FacilitatorAppointment> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, FacilitatorAppointment> = {};
  let count = 0;
  for (const uid of Object.keys(v as Record<string, unknown>).sort()) {
    if (count >= GROUP_FIELD_LIMITS.maxFacilitatorAppointments) break;
    const value = (v as Record<string, unknown>)[uid];
    if (!uid || !value || typeof value !== "object") continue;
    const raw = value as Raw;
    out[uid] = {
      at: tsToDate(raw.at),
      byUid: typeof raw.byUid === "string" ? raw.byUid : "",
      byName: str(raw.byName, GROUP_FIELD_LIMITS.appointedByName),
      agreedAt: tsToDate(raw.agreedAt),
    };
    count += 1;
  }
  return out;
}

export function normalizeCourseGroup(id: string, data: Raw): CourseGroupDoc {
  const capacityRaw = data.capacity;
  const capacity =
    typeof capacityRaw === "number" && Number.isFinite(capacityRaw) && capacityRaw > 0
      ? Math.floor(capacityRaw)
      : null;
  return {
    id,
    runId: (data.runId as string) ?? "",
    courseId: (data.courseId as string) ?? "",
    name: str(data.name, GROUP_FIELD_LIMITS.name),
    facilitatorUids: asUidList(data.facilitatorUids),
    facilitatorAppointments: normalizeFacilitatorAppointments(
      data.facilitatorAppointments,
    ),
    // Absent, empty and non-string all mean "open to every stream", the same
    // degrade-to-the-widest-safe-state rule the pace fields follow. A garbled
    // id would otherwise scope a group to a stream nobody is on, which reads
    // as an empty group rather than as an error.
    streamId:
      typeof data.streamId === "string" && data.streamId ? data.streamId : null,
    capacity,
    memberCount:
      typeof data.memberCount === "number" && Number.isFinite(data.memberCount)
        ? Math.max(0, Math.floor(data.memberCount))
        : 0,
    session: normalizeSession(data.session),
    sessionOverrides: foldSessionModes(
      normalizeSessionOverrides(data.sessionOverrides),
      data.sessionModes,
    ),
    // Absent, null and INVALID all normalise to null (= track the run): a
    // garbled pace date must degrade to the run canonical, never pace a group
    // to a garbage week. `isValidDateKey` (not a bare regex) from day one —
    // the impossible-date hole `asCivilDate` still carries is documented in
    // scripts/rules-tests/tests/courses-schedule.test.mjs and is not
    // reproduced here.
    paceStartDate:
      typeof data.paceStartDate === "string" && isValidDateKey(data.paceStartDate)
        ? data.paceStartDate
        : null,
    paceWeekPlan: Array.isArray(data.paceWeekPlan)
      ? sanitizeWeekPlan(data.paceWeekPlan)
      : null,
    archived: data.archived === true,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Forked group weeks (v2 decision 4 — copy-on-write content)
// ---------------------------------------------------------------------------

/**
 * `courseGroups/{groupId}/weeks/{wNN}` — ONE group's fork of one canonical
 * week. EXACT `CourseWeekDoc` shape (same doc id, same `material.id` /
 * `exercise.id` / `checklist.id` — the id-preserving platform invariant from
 * `courseTemplates.templateWeekFields`, which the fork route copies through),
 * plus the fork provenance stamp.
 *
 * Existence IS the signal: a member's week content = their group's forked
 * week if this doc exists, else the run canonical — resolved only through
 * `src/lib/courses/groupResolve.ts`. All writes are server-routed
 * (`allow write: if false` in rules); signed-in read matches run weeks.
 */
export type GroupWeekDoc = CourseWeekDoc & {
  /** When this group's copy split from canonical. */
  forkedAt: Date | null;
  forkedByUid: string;
  /**
   * The canonical week's `updatedAt` AT FORK TIME (null when the canonical
   * carried none) — the point-in-time record of what was copied, so "has
   * canonical moved on since we forked" stays answerable after the fact.
   */
  forkedFromRunWeekAt: Date | null;
};

export function normalizeGroupWeek(id: string, data: Raw): GroupWeekDoc {
  return {
    ...normalizeCourseWeek(id, data),
    forkedAt: tsToDate(data.forkedAt),
    forkedByUid: typeof data.forkedByUid === "string" ? data.forkedByUid : "",
    forkedFromRunWeekAt: tsToDate(data.forkedFromRunWeekAt),
  };
}
