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
