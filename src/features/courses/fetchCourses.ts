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
import {
  applicationWindow,
  type ApplicationWindow,
} from "@/lib/courses/window";

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
 *  - runs must not be `archived`,
 *  - weeks must be `published === true`.
 *
 * Any new fetcher added here inherits that obligation.
 *
 * There is a SECOND obligation, added when the read-time application window
 * landed: nothing in this file may decide whether a run is taking
 * applications by looking at `status` on its own. `applicationWindow()` in
 * `lib/courses/window.ts` is the only predicate, and the apply route calls the
 * same one. Keying on status alone is what let a run sit past its deadline
 * advertising an open application and then refuse the POST.
 *
 * `archived` is the V2-1 deletion protocol's everyday soft path, and this
 * file is where most of its promise is kept: "an archived run drops out of
 * the public catalogue" is only true because the two run lookups below skip
 * it and the showcase resolution treats it like a draft. The destroy cascade
 * sets the same flag in its opening transaction, so a run mid-destroy is off
 * these surfaces before the first row dies — which is the whole "unreachable
 * at destroy start" guarantee, and it is worth exactly as much as these
 * filters are.
 */

/**
 * A run paired with the window state that decides what a surface may say
 * about it. Never one without the other: handing a caller a bare run is how
 * the "Applications open" copy got out of step with the deadline in the
 * first place.
 */
export type RunWindow = {
  run: CourseRunDoc;
  window: ApplicationWindow;
};

/** One catalogue row: a published course plus the run its card speaks about. */
export type CourseCatalogueEntry = {
  course: CourseDoc;
  /**
   * The run the card describes, with its window state, or null when the
   * course has nothing to advertise. `window.state` is `open`, `not-yet` or
   * `closed`, and the card's copy has to branch on all three.
   */
  featuredRun: RunWindow | null;
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
 * The mirror of `preferredOpenRun` for runs that have already shut: the MOST
 * RECENTLY closed wins, because that is the one an applicant is asking about
 * between the deadline and the decision. A run with no close date carries no
 * recency signal at all (it was shut by an admin flipping the status), so it
 * sorts last rather than pretending to be newest.
 */
function preferredClosedRun(a: CourseRunDoc, b: CourseRunDoc): CourseRunDoc {
  const av = a.applicationsCloseAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bv = b.applicationsCloseAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (av !== bv) return av > bv ? a : b;
  // Civil date strings sort lexicographically the same way they sort
  // chronologically, so the later start wins without parsing anything.
  if (a.startDate !== b.startDate) return a.startDate > b.startDate ? a : b;
  return a.label.localeCompare(b.label) <= 0 ? a : b;
}

/**
 * Which of two runs a public surface should describe. Taking applications
 * beats opening soon beats already closed, so a course with a live window
 * never advertises last term instead. `inactive` never reaches here: draft
 * and archived runs are dropped before the comparison.
 */
function preferredRunWindow(a: RunWindow, b: RunWindow): RunWindow {
  const rank = { open: 0, "not-yet": 1, closed: 2, inactive: 3 } as const;
  const ra = rank[a.window.state];
  const rb = rank[b.window.state];
  if (ra !== rb) return ra < rb ? a : b;
  const winner =
    a.window.state === "closed"
      ? preferredClosedRun(a.run, b.run)
      : preferredOpenRun(a.run, b.run);
  return winner === a.run ? a : b;
}

/**
 * Every published course, each paired with the run its card speaks about.
 *
 * Two queries total, never N+1: one for the courses, one for ALL runs in
 * `applications-open` across the whole site, which is then indexed by
 * courseId. The site runs a handful of courses a year, so the set is tiny and
 * this stays cheaper than a per-course lookup.
 *
 * The query still asks for `applications-open`, because that is the only
 * status whose window can be `open` or `not-yet`. What changed is that the
 * STATUS no longer decides the copy: each run's window is computed here, and
 * a run sitting past its deadline comes back `closed` so the card says so
 * instead of inviting an application the route would refuse.
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

  // One clock reading for the whole page, so two cards can never land on
  // opposite sides of the same deadline within one render.
  const now = new Date();
  const byCourse = new Map<string, RunWindow>();
  for (const d of runSnap.docs) {
    const run = normalizeCourseRun(d.id, d.data());
    if (!run.courseId) continue;
    const window = applicationWindow(run, now);
    // Archived (and therefore also mid-destroy) runs come back `inactive` and
    // are withdrawn from the catalogue. Filtered here rather than in the query
    // because a second equality on a status query is a composite index this
    // feature has not shipped, and the run set is tiny (see the doc comment).
    if (window.state === "inactive") continue;
    const candidate: RunWindow = { run, window };
    const existing = byCourse.get(run.courseId);
    byCourse.set(
      run.courseId,
      existing ? preferredRunWindow(existing, candidate) : candidate,
    );
  }

  return courseSnap.docs
    .map((d) => normalizeCourse(d.id, d.data()))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((course) => ({
      course,
      featuredRun: byCourse.get(course.id) ?? null,
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
  // A draft run is unfinished authoring, not a shop window. An ARCHIVED run
  // is a withdrawn one, which is the same answer for a different reason —
  // and it is the case that matters during a destroy, because the cascade
  // only clears `showcaseRunId` in its FINAL batch. Between the first deleted
  // row and that batch the course still points here, and without this the
  // public page would render the curriculum of a run being emptied out.
  if (showcaseRun.status === "draft" || showcaseRun.archived) {
    return { course, showcaseRun: null, weeks: [] };
  }

  return {
    course,
    showcaseRun,
    weeks: await listPublishedWeeks(db, showcaseRun.id),
  };
}

/**
 * The run one course's public surfaces should describe, with its window
 * state, or null when the course has never had a public run.
 *
 * Deliberately NOT "the open run". The course page CTA and the apply page
 * both need an answer between the deadline and the decision, and returning
 * null there is exactly what made an applicant's own status card unreachable
 * the moment admissions moved the run to `applications-closed`: the apply
 * page had no run to read a row against, so the one surface that ever told
 * someone their application existed vanished on the day they started asking.
 *
 * So this returns the best CANDIDATE: a run taking applications if there is
 * one, else one opening soon, else the most recently closed. Draft and
 * archived runs are never candidates.
 *
 * Filters client-side over a `courseId`-only query: both fields are
 * single-field auto-indexed, and a course has a handful of runs ever, so this
 * stays index-free (`firestore.indexes.json` carries no courseId+status pair).
 */
export async function getApplicationRunForCourse(
  courseId: string,
): Promise<RunWindow | null> {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db
    .collection("courseRuns")
    .where("courseId", "==", courseId)
    .limit(50)
    .get();
  // One clock reading for every candidate, so the ranking is a total order.
  const now = new Date();
  let best: RunWindow | null = null;
  for (const d of snap.docs) {
    const run = normalizeCourseRun(d.id, d.data());
    const window = applicationWindow(run, now);
    // Draft and archived alike: unfinished authoring and withdrawn runs are
    // not public, and the destroy cascade sets `archived` first, so this is
    // also what keeps a run mid-destroy off the page.
    if (window.state === "inactive") continue;
    const candidate: RunWindow = { run, window };
    best = best ? preferredRunWindow(best, candidate) : candidate;
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

/** Everything the apply page needs, or null when the course has no run yet. */
export type ApplyContext = {
  course: CourseDoc;
  /** The run the page describes, and the one the form submits against. */
  run: CourseRunDoc;
  /**
   * That run's window. `open` renders the form; `not-yet` and `closed` render
   * a dated card, and the applicant's OWN status card if they hold a row.
   */
  window: ApplicationWindow;
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
 * The apply page's one read: a published course, the run it describes, that
 * run's window state, and the session times an applicant can say they're free
 * for.
 *
 * Returns null ONLY when there is genuinely nothing to describe: an unknown
 * course, a draft course, or a course with no non-draft run at all. It
 * deliberately keeps returning a CLOSED run, which is the fix for the second
 * applicant blocker: the apply page is the only surface that shows someone
 * their own application, and it used to disappear the moment admissions
 * closed the run, which is precisely the fortnight people spend asking
 * whether their application arrived. The page renders the status card from
 * this run in every window state; only the form is gated on `open`.
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

  // Independent reads, so they go together: the draft-course path throws the
  // run query away, which is cheaper than serialising every real hit (the same
  // call the course detail page makes).
  const [doc, found] = await Promise.all([
    db.collection("courses").doc(courseId).get(),
    getApplicationRunForCourse(courseId),
  ]);
  if (!doc.exists || !found) return null;
  const { run, window } = found;
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

  return { course, run, window, groups: rows.map((r) => r.option) };
}
