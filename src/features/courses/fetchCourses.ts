import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  normalizeCourse,
  normalizeCourseRun,
  normalizeCourseWeek,
  type CourseDoc,
  type CourseRunDoc,
  type CourseWeekDoc,
} from "@/lib/firestore/courses";
import {
  normalizeCourseGroup,
  type GroupSession,
} from "@/lib/firestore/courseGroups";

/**
 * Server-only fetchers for the public course pages (`fetchEvents.ts` pattern).
 *
 * These run through the Admin SDK, so Firestore rules provide NO defence here —
 * deliberately, because no public read rule exists for `courses` / `courseRuns`
 * / `weeks` (`allow read` grants `list`, which would make every draft
 * world-listable). Visibility is therefore OURS to enforce, and every function
 * below filters on it before returning anything:
 *
 *  - courses must be `status === "published"`,
 *  - the showcase run must not be a `draft`,
 *  - weeks must be `published === true`.
 *
 * Any new fetcher added here inherits that obligation.
 */

/** One catalogue row: a published course plus the run taking applications. */
export type CourseCatalogueEntry = {
  course: CourseDoc;
  /** The run currently accepting applications, or null when none is open. */
  openRun: CourseRunDoc | null;
};

/** A published course with the curriculum its showcase run puts on display. */
export type PublicCourse = {
  course: CourseDoc;
  /** The run whose weeks are shown publicly. Null = no curriculum preview. */
  showcaseRun: CourseRunDoc | null;
  /** The showcase run's PUBLISHED weeks, ordered by weekNumber. */
  weeks: CourseWeekDoc[];
};

/** A single public week, with enough context to render its header and nav. */
export type PublicWeek = {
  course: CourseDoc;
  run: CourseRunDoc;
  week: CourseWeekDoc;
  /**
   * How many weeks the public curriculum has ("Week 3 of 8"). This is the
   * count of PUBLISHED weeks, not the run's planned length — an in-progress
   * curriculum shouldn't advertise weeks nobody can read yet. Callers deriving
   * next/prev links from it should still tolerate a miss (`notFound()`), since
   * an author can publish weeks out of order.
   */
  totalWeeks: number;
};

/** Read a run's published weeks in week order. Shared by the two week paths. */
async function listPublishedWeeks(
  db: NonNullable<ReturnType<typeof getAdminDb>>,
  runId: string,
): Promise<CourseWeekDoc[]> {
  // No `orderBy` alongside the `published` filter: that pairing needs a
  // composite index on the subcollection and none is provisioned. weekNumber
  // is always present, so a client-side sort is exact and index-free.
  const snap = await db
    .collection("courseRuns")
    .doc(runId)
    .collection("weeks")
    .where("published", "==", true)
    .get();
  return snap.docs
    .map((d) => normalizeCourseWeek(d.id, d.data()))
    .sort((a, b) => a.weekNumber - b.weekNumber);
}

/**
 * Pick which open run a catalogue card should advertise when a course somehow
 * has more than one. Soonest-closing first (an unbounded window sorts last),
 * then label, so the choice is deterministic across requests rather than
 * whatever order Firestore happened to return.
 */
function preferredOpenRun(a: CourseRunDoc, b: CourseRunDoc): CourseRunDoc {
  const av = a.applicationsCloseAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bv = b.applicationsCloseAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (av !== bv) return av < bv ? a : b;
  return a.label.localeCompare(b.label) <= 0 ? a : b;
}

/**
 * Every published course, each paired with its open run (if any).
 *
 * Two queries total, never N+1: one for the courses, one for ALL runs in
 * `applications-open` across the whole site, which is then indexed by
 * courseId. The site runs a handful of courses a year, so the open-run set is
 * tiny and this stays cheaper than a per-course lookup.
 */
export async function listPublishedCourses(): Promise<CourseCatalogueEntry[]> {
  const db = getAdminDb();
  if (!db) return [];

  const [courseSnap, runSnap] = await Promise.all([
    db.collection("courses").where("status", "==", "published").limit(100).get(),
    db
      .collection("courseRuns")
      .where("status", "==", "applications-open")
      .limit(200)
      .get(),
  ]);

  const openByCourse = new Map<string, CourseRunDoc>();
  for (const d of runSnap.docs) {
    const run = normalizeCourseRun(d.id, d.data());
    if (!run.courseId) continue;
    const existing = openByCourse.get(run.courseId);
    openByCourse.set(
      run.courseId,
      existing ? preferredOpenRun(existing, run) : run,
    );
  }

  return courseSnap.docs
    .map((d) => normalizeCourse(d.id, d.data()))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((course) => ({
      course,
      openRun: openByCourse.get(course.id) ?? null,
    }));
}

/**
 * One published course plus the curriculum on public display. Returns null for
 * an unknown or unpublished course — callers `notFound()` on it, so a draft is
 * indistinguishable from a typo'd URL.
 */
export async function getPublishedCourse(
  courseId: string,
): Promise<PublicCourse | null> {
  const db = getAdminDb();
  if (!db) return null;

  const doc = await db.collection("courses").doc(courseId).get();
  if (!doc.exists) return null;
  const course = normalizeCourse(doc.id, doc.data() ?? {});
  if (course.status !== "published") return null;

  if (!course.showcaseRunId) return { course, showcaseRun: null, weeks: [] };

  const runDoc = await db
    .collection("courseRuns")
    .doc(course.showcaseRunId)
    .get();
  if (!runDoc.exists) return { course, showcaseRun: null, weeks: [] };
  const showcaseRun = normalizeCourseRun(runDoc.id, runDoc.data() ?? {});
  // A draft run is unfinished authoring, not a shop window.
  if (showcaseRun.status === "draft") {
    return { course, showcaseRun: null, weeks: [] };
  }

  return {
    course,
    showcaseRun,
    weeks: await listPublishedWeeks(db, showcaseRun.id),
  };
}

/**
 * The run currently accepting applications for one course, or null.
 *
 * The detail page needs this and the catalogue's bulk map isn't reachable from
 * a single-course route. Filters `status` client-side over a `courseId`-only
 * query: both fields are single-field auto-indexed, and a course has a handful
 * of runs ever, so this stays index-free — no composite to ship ahead of the
 * code (`firestore.indexes.json` carries no courseId+status pair).
 */
export async function getOpenRunForCourse(
  courseId: string,
): Promise<CourseRunDoc | null> {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db
    .collection("courseRuns")
    .where("courseId", "==", courseId)
    .limit(50)
    .get();
  let best: CourseRunDoc | null = null;
  for (const d of snap.docs) {
    const run = normalizeCourseRun(d.id, d.data());
    if (run.status !== "applications-open") continue;
    best = best ? preferredOpenRun(best, run) : run;
  }
  return best;
}

/**
 * One published week of a published course's showcase run, by week NUMBER (the
 * public URL segment) rather than doc id — week ids are preserved across
 * copy-forward, so a week's id and its number in a given run need not match.
 */
export async function getPublicWeek(
  courseId: string,
  weekNumber: number,
): Promise<PublicWeek | null> {
  const found = await getPublishedCourse(courseId);
  if (!found || !found.showcaseRun) return null;
  const week = found.weeks.find((w) => w.weekNumber === weekNumber);
  if (!week) return null;
  return {
    course: found.course,
    run: found.showcaseRun,
    week,
    totalWeeks: found.weeks.length,
  };
}

// ---- Apply page ----

/**
 * One group, reduced to what an APPLICANT may see: an id, the group's name,
 * and its recurring slot as a label. Deliberately NOT the group doc — that
 * carries the meeting URL, the room, and the facilitator uids, none of which
 * belong on a public page (`courseGroups` is read-restricted in rules for
 * exactly that reason, and the Admin SDK bypasses rules here).
 *
 * The label is the availability chip's VALUE as well as its text: the apply
 * route stores availability as member-authored strings, so what the applicant
 * ticked reads back verbatim in the review queue.
 */
export type ApplyGroupOption = {
  id: string;
  name: string;
  /** e.g. "Tuesdays 18:00–19:30". Never empty (slot-less groups are dropped). */
  sessionLabel: string;
};

/** Everything the apply page needs, or null when nobody can apply right now. */
export type ApplyContext = {
  course: CourseDoc;
  /** The run in `applications-open` — the one the form submits against. */
  run: CourseRunDoc;
  /** Session-time options for the availability chips; empty when unallocated. */
  groups: ApplyGroupOption[];
};

/** Index = `Date.getDay()`, matching `GroupSession.weekday` (0 = Sunday). */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * "18:00" + 90 → "19:30". Wall-clock arithmetic for a display label only —
 * this deliberately duplicates `SessionSlotField`'s helper rather than
 * importing it (that module is `"use client"`, and this one is `server-only`).
 * Nothing here reasons about DST: real instants come from
 * `londonWallClockToInstant()` in `lib/courses/weekPlan.ts`.
 */
function endTimeLabel(start: string, minutes: number): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m || minutes <= 0) return null;
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** "Tuesdays 18:00–19:30", or null when the slot isn't set up yet. */
function sessionLabel(session: GroupSession): string | null {
  const day = WEEKDAY_NAMES[session.weekday];
  if (!day || !session.startTimeLocal) return null;
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  return `${day}s ${session.startTimeLocal}${end ? `–${end}` : ""}`;
}

/**
 * The apply page's one read: a published course, the run taking applications,
 * and the session times an applicant can say they're free for.
 *
 * Returns null whenever there is nothing to apply to — unknown course, draft
 * course, or no open run — so the page renders one honest "not open" card
 * instead of three near-identical ones. The run is picked by the SAME
 * `preferredOpenRun` tie-break the catalogue uses, so the card that said
 * "Applications open — Autumn 2026" and the form always agree.
 *
 * Groups are best-effort context, never a gate: applicants do NOT pick a
 * group or a facilitator here (admissions records preferences later), and a
 * run with no groups yet simply renders no availability section.
 */
export async function getApplyContext(
  courseId: string,
): Promise<ApplyContext | null> {
  const db = getAdminDb();
  if (!db) return null;

  // Independent reads, so they go together — the draft-course path throws the
  // run query away, which is cheaper than serialising every real hit (the same
  // call the course detail page makes).
  const [doc, run] = await Promise.all([
    db.collection("courses").doc(courseId).get(),
    getOpenRunForCourse(courseId),
  ]);
  if (!doc.exists || !run) return null;
  const course = normalizeCourse(doc.id, doc.data() ?? {});
  // Same visibility obligation as every fetcher in this file (module comment):
  // an unpublished course has no public apply page.
  if (course.status !== "published") return null;

  const groupSnap = await db
    .collection("courseGroups")
    .where("runId", "==", run.id)
    .limit(50)
    .get();

  const rows: Array<{ option: ApplyGroupOption; day: number; start: string }> = [];
  for (const d of groupSnap.docs) {
    const group = normalizeCourseGroup(d.id, d.data());
    if (group.archived) continue;
    const label = sessionLabel(group.session);
    // A group whose slot isn't set yet has no time to offer — dropping it
    // beats a chip reading "Sundays" for a session nobody has scheduled.
    if (!label) continue;
    rows.push({
      option: { id: group.id, name: group.name, sessionLabel: label },
      // Monday-first for display: `weekday` is stored Sunday-first
      // (`Date.getDay()`), which is a timetable nobody in the UK reads.
      day: (group.session.weekday + 6) % 7,
      start: group.session.startTimeLocal,
    });
  }
  // Timetable order (day, then start time), not doc order — the chips read as
  // a week. "HH:MM" is zero-padded, so a string compare IS time order.
  rows.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));

  return { course, run, groups: rows.map((r) => r.option) };
}
