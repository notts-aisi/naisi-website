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

export type CourseGroupDoc = {
  /** Firestore doc id: `slugId(runLabel + name)`. */
  id: string;
  runId: string;
  courseId: string;
  name: string;
  /** Server-owned (routes only, pinned in rules). Max 5. */
  facilitatorUids: string[];
  /** Allocation cap; null = uncapped. */
  capacity: number | null;
  /** Server-owned counter, maintained by the allocation transaction. */
  memberCount: number;
  /** The recurring weekly slot. */
  session: GroupSession;
  /**
   * Per-week deviations from the recurring slot, keyed by week doc id
   * ("w03"). A partial: only the fields that differ that week are stored
   * (e.g. just a `location` change, or a moved `startTimeLocal`). Capped at
   * 20 keys so a group doc can't grow unboundedly.
   */
  sessionOverrides: Record<string, Partial<GroupSession>>;
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
} as const;

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
 */
function normalizeSessionOverride(v: unknown): Partial<GroupSession> {
  const raw = (v ?? {}) as Raw;
  const out: Partial<GroupSession> = {};
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
): Record<string, Partial<GroupSession>> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, Partial<GroupSession>> = {};
  let count = 0;
  for (const [weekId, value] of Object.entries(v as Record<string, unknown>)) {
    if (count >= GROUP_FIELD_LIMITS.maxSessionOverrides) break;
    if (!value || typeof value !== "object") continue;
    out[weekId] = normalizeSessionOverride(value);
    count += 1;
  }
  return out;
}

/**
 * The effective session for a given week: the recurring slot with that week's
 * override (if any) laid over it. Pure derivation — nothing stores the merged
 * result, so a corrected override is instantly right everywhere.
 */
export function sessionForWeek(group: CourseGroupDoc, weekId: string): GroupSession {
  const override = group.sessionOverrides[weekId];
  if (!override) return group.session;
  return { ...group.session, ...override };
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
    capacity,
    memberCount:
      typeof data.memberCount === "number" && Number.isFinite(data.memberCount)
        ? Math.max(0, Math.floor(data.memberCount))
        : 0,
    session: normalizeSession(data.session),
    sessionOverrides: normalizeSessionOverrides(data.sessionOverrides),
    archived: data.archived === true,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}
