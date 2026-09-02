import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  groupFullError,
  normalizeCourseGroup,
  type CourseGroupDoc,
} from "@/lib/firestore/courseGroups";

/**
 * The PUBLIC group picker's data: the session slots an open-enrolment run is
 * offering, reduced to the handful of fields a visitor may see.
 *
 * ── WHY THE PROJECTION IS WRITTEN OUT FIELD BY FIELD ────────────────────────
 * `courseGroups` is read-restricted in `firestore.rules` on purpose: a group
 * document carries `meetingUrl` (a joinable video link), `notes` (whatever a
 * facilitator wrote to their co-staff), `location` (a room, and by extension
 * where a named person will be at a known time each week) and
 * `facilitatorUids`. This module runs on the Admin SDK, so rules provide NO
 * defence here at all: whatever it returns is what an anonymous visitor gets.
 *
 * So `projectGroupForPicker` names its output keys one by one and never
 * spreads a group document. A spread plus a delete-list is the shape that
 * leaks: the next field somebody adds to `CourseGroupDoc` ships to the public
 * page the day it lands, and nobody notices until the meeting link is in a
 * search index. `tests/course-enrol.test.mjs` pins the key set exactly, so
 * adding a field here is a deliberate, reviewed act.
 *
 * `seatsLeft` is derived rather than stored: it is `capacity - memberCount`,
 * floored at zero. It is ADVISORY, and the copy around it must never promise
 * a seat. The transaction in the enrol route is the only thing that decides
 * who gets the last place, and it reads the counter inside the transaction
 * precisely because this number is stale the moment it is rendered.
 */

export type GroupPickerOption = {
  id: string;
  name: string;
  /** 0 = Sunday .. 6 = Saturday (JS `Date.getDay()` convention). */
  weekday: number;
  /** Wall-clock start in Europe/London, "HH:MM" 24h. */
  startTimeLocal: string;
  durationMinutes: number;
  /** The stream this session teaches, or null when it takes every stream. */
  streamId: string | null;
  /** Seat cap. Never null on an open-enrolment run (the run refuses to open
      without one), so the picker can always show a number. */
  capacity: number | null;
  /** `capacity - memberCount`, floored at 0; null when uncapped. Advisory. */
  seatsLeft: number | null;
  /** True when there is no room left. Derived through `groupFullError`, the
      same predicate the enrol transaction uses, so the button a visitor sees
      disabled and the 409 they would have got agree. */
  full: boolean;
};

/**
 * One group document reduced to the picker's shape. PURE, and exported for
 * the projection test: the guarantee this file exists to make is testable
 * only if the mapping can be called on a fully-populated group without a
 * database.
 */
export function projectGroupForPicker(group: CourseGroupDoc): GroupPickerOption {
  const seatsLeft =
    group.capacity === null
      ? null
      : Math.max(0, group.capacity - group.memberCount);
  return {
    id: group.id,
    name: group.name,
    weekday: group.session.weekday,
    startTimeLocal: group.session.startTimeLocal,
    durationMinutes: group.session.durationMinutes,
    streamId: group.streamId,
    capacity: group.capacity,
    seatsLeft,
    full:
      groupFullError({
        name: group.name,
        capacity: group.capacity,
        memberCount: group.memberCount,
      }) !== null,
  };
}

/**
 * Every session slot an open-enrolment run is offering, in timetable order.
 *
 * Archived groups are dropped (they are not on offer), and so are groups with
 * no start time yet: a card reading "Sundays" for a session nobody has
 * scheduled is worse than one fewer card, and `getApplyContext` already drops
 * slot-less groups for the same reason.
 *
 * NOT gated on the run's enrol mode or window. The caller knows both, and a
 * fetcher that silently returned nothing for an admissions run would make an
 * empty picker indistinguishable from a run with no groups. Callers render
 * the picker only when `isEnrolOpen()` says so.
 */
export async function fetchGroupPicker(runId: string): Promise<GroupPickerOption[]> {
  const db = getAdminDb();
  if (!db) return [];

  const snap = await db
    .collection("courseGroups")
    .where("runId", "==", runId)
    .limit(50)
    .get();

  const rows: Array<{ option: GroupPickerOption; day: number; start: string }> = [];
  for (const d of snap.docs) {
    const group = normalizeCourseGroup(d.id, d.data() ?? {});
    if (group.archived) continue;
    if (!group.session.startTimeLocal) continue;
    rows.push({
      option: projectGroupForPicker(group),
      // Monday-first for display: `weekday` is stored Sunday-first
      // (`Date.getDay()`), which is a timetable nobody in the UK reads.
      day: (group.session.weekday + 6) % 7,
      start: group.session.startTimeLocal,
    });
  }
  // "HH:MM" is zero-padded, so a string compare IS time order.
  rows.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return rows.map((r) => r.option);
}
