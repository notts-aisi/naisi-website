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
import { type ApplicationWindow } from "@/lib/courses/window";
import { courseRunWindow } from "@/lib/courses/enrolWindow";
import { COURSE_TRACKS } from "@/lib/firestore/courses";
import {
  COURSE_PAGES_COLLECTION,
  normalizeCoursePage,
  toPublicCoursePage,
  type PublicCoursePage,
} from "@/lib/firestore/coursePages";
import {
  listLiveRoundsByCourse,
  type CourseLiveRound,
} from "./fetchLiveRound";

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
 * applications by looking at `status` on its own. `courseRunWindow()` in
 * `lib/courses/enrolWindow.ts` is the only predicate, and the routes call the
 * predicate it dispatches to. Keying on status alone is what let a run sit
 * past its deadline advertising an open application and then refuse the POST.
 *
 * `courseRunWindow()` rather than `applicationWindow()` directly, because
 * there are now TWO ways onto a run. An `open` run (the pre-course) has no
 * application at all and admits people while it is `applications-closed` or
 * even `running`; asking the application predicate about one would report
 * "closed" about a bootcamp taking sign-ups that evening. The dispatcher
 * picks by `enrolMode`, and every window in this file goes through it.
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
  /**
   * The ADMISSION ROUND that places people onto one of this course's runs, or
   * null when no round names any of them.
   *
   * When it is present it OUTRANKS the run's own window for every date on the
   * card: a round is the object an applicant applies to, it carries the dates
   * an admin typed, and the run's `applicationsCloseAt` is the pre-round
   * mechanism kept for open-enrolment courses. Two dates naming the same
   * deadline is exactly the drift V3 exists to stop, so the card reads one of
   * them and the choice is made here rather than in the component.
   */
  liveRound: CourseLiveRound | null;
  /**
   * What the card's artwork is drawn from: the authored seed and cover, or
   * the course id as the seed when nobody has authored a page.
   *
   * Read here rather than on the card so the catalogue tile and the hero on
   * the course page are THE SAME picture. Seeding the card from the course id
   * would have been one read cheaper and would have quietly given a course two
   * different visuals, which is the sort of thing nobody reports and everybody
   * notices.
   */
  visual: { seed: string; coverImageUrl: string | null; coverAlt: string };
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
 * The status query still asks for `applications-open`, because for an
 * ADMISSIONS run that is the only status whose window can be `open` or
 * `not-yet`. What changed first is that the STATUS no longer decides the copy:
 * each run's window is computed here, and a run sitting past its deadline
 * comes back `closed` so the card says so instead of inviting an application
 * the route would refuse.
 *
 * A SECOND QUERY covers open-enrolment runs, and it is not an optimisation.
 * A pre-course keeps taking sign-ups in `applications-closed` and in
 * `running` (its parent intake shuts on 18 October while its own sessions
 * keep going), so the status query alone would drop the one run on the site
 * that is most obviously open. `enrolMode` is a single equality on an
 * auto-indexed field, so this needs no composite index; duplicates between
 * the two result sets are folded by the same per-course ranking.
 */
export async function listPublishedCourses(): Promise<CourseCatalogueEntry[]> {
  const db = getAdminDb();
  if (!db) return [];

  const [courseSnap, runSnap, openRunSnap] = await Promise.all([
    db.collection("courses").where("status", "==", "published").limit(100).get(),
    db
      .collection("courseRuns")
      .where("status", "==", "applications-open")
      .limit(200)
      .get(),
    db.collection("courseRuns").where("enrolMode", "==", "open").limit(200).get(),
  ]);

  // One clock reading for the whole page, so two cards can never land on
  // opposite sides of the same deadline within one render.
  const now = new Date();
  const byCourse = new Map<string, RunWindow>();
  // A run in `applications-open` AND `enrolMode: open` appears in both
  // snapshots; `preferredRunWindow` is a total order, so seeing it twice is
  // idempotent and no de-duplication pass is needed.
  const runDocs = [...runSnap.docs, ...openRunSnap.docs];
  for (const d of runDocs) {
    const run = normalizeCourseRun(d.id, d.data());
    if (!run.courseId) continue;
    const window = courseRunWindow(run, now);
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

  // The rounds pass reuses the run documents already read above as its
  // run-to-course map, so the only rows it has to fetch are the runs a round
  // names that no run query returned (a target run still in `draft`).
  const knownRuns = new Map<string, string>();
  for (const d of runDocs) {
    const courseId = d.data()?.courseId;
    if (typeof courseId === "string" && courseId) knownRuns.set(d.id, courseId);
  }
  const courses = courseSnap.docs.map((d) => normalizeCourse(d.id, d.data()));

  const [roundsByCourse, pages] = await Promise.all([
    listLiveRoundsByCourse(knownRuns, now),
    // ONE batch read for every card's artwork. The page id IS the course id,
    // so this needs no query and no index; a course with no authored page
    // comes back missing and falls through to the id-seeded default.
    courses.length > 0
      ? db.getAll(
          ...courses.map((c) => db.collection(COURSE_PAGES_COLLECTION).doc(c.id)),
        )
      : Promise.resolve([]),
  ]);

  const visuals = new Map<string, PublicCoursePage>();
  for (const doc of pages) {
    if (!doc.exists) continue;
    visuals.set(doc.id, toPublicCoursePage(normalizeCoursePage(doc.id, doc.data() ?? {})));
  }

  return courses
    .map((course) => {
      const page = visuals.get(course.id) ?? null;
      return {
        course,
        featuredRun: byCourse.get(course.id) ?? null,
        liveRound: roundsByCourse.get(course.id) ?? null,
        visual: {
          seed: page?.visualSeed || course.id,
          coverImageUrl: page?.coverImageUrl ?? null,
          coverAlt: page?.coverAlt ?? "",
        },
      };
    })
    .sort(compareCatalogueEntries);
}

/**
 * How openly a catalogue row is taking people, as a sort key. The ROUND wins
 * when there is one, for the reason `liveRound` documents: it is the object
 * people apply to, and the run's own window is the pre-round mechanism that
 * open-enrolment courses still use.
 */
function opennessRank(entry: CourseCatalogueEntry): number {
  const state = entry.liveRound?.state ?? entry.featuredRun?.window.state ?? null;
  if (state === "open") return 0;
  if (state === "not-yet") return 1;
  return 2;
}

/**
 * Catalogue order: what you can apply to NOW, then what opens soon, then
 * everything else; within a band, by track and then by title.
 *
 * Alphabetical order was the previous rule and it buries the one thing the
 * page exists for: in a term where the incubator is open and three past
 * fellowships are not, "Applications open" can sit fourth on the grid because
 * of a letter. Track is the secondary key rather than the title so the
 * technical and governance strands read as strands rather than as an
 * interleaved alphabet, and `COURSE_TRACKS` supplies that order so the
 * catalogue, the chips and the filters cannot disagree about it.
 *
 * Exported because it is the half of the catalogue worth pinning with a test:
 * it is decidable from two plain objects and it is what a reader notices first.
 */
export function compareCatalogueEntries(
  a: CourseCatalogueEntry,
  b: CourseCatalogueEntry,
): number {
  const rank = opennessRank(a) - opennessRank(b);
  if (rank !== 0) return rank;
  const track = COURSE_TRACKS.indexOf(a.course.track) - COURSE_TRACKS.indexOf(b.course.track);
  if (track !== 0) return track;
  return a.course.title.localeCompare(b.course.title);
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
  return (await getCourseRunSet(courseId)).featuredRun;
}

/**
 * One course's runs, read once and answered twice: the run its public
 * surfaces describe, AND every run id the course has.
 *
 * The id list is what the round lookup needs. A round names RUNS
 * (`outcomeRunIds`) and `courseRuns.admissionRoundIds` does not exist yet, so
 * the only way from a course to its round is through its runs, and the ids
 * have to include the ones `getApplicationRunForCourse` drops: an autumn
 * intake's target run sits in `draft` right up until allocation, which is
 * precisely the window in which the page most needs to name the round.
 *
 * One query for both answers, because the page needs both and reading the
 * same fifty documents twice on every render is the kind of thing that only
 * looks free.
 */
export type CourseRunSet = {
  /** Every run of this course, draft and archived included. */
  runIds: string[];
  /** The run the public surfaces describe, or null. */
  featuredRun: RunWindow | null;
};

export async function getCourseRunSet(courseId: string): Promise<CourseRunSet> {
  const db = getAdminDb();
  if (!db) return { runIds: [], featuredRun: null };
  const snap = await db
    .collection("courseRuns")
    .where("courseId", "==", courseId)
    .limit(50)
    .get();
  // One clock reading for every candidate, so the ranking is a total order.
  const now = new Date();
  const runIds: string[] = [];
  let best: RunWindow | null = null;
  for (const d of snap.docs) {
    runIds.push(d.id);
    const run = normalizeCourseRun(d.id, d.data());
    const window = courseRunWindow(run, now);
    // Draft and archived alike: unfinished authoring and withdrawn runs are
    // not public, and the destroy cascade sets `archived` first, so this is
    // also what keeps a run mid-destroy off the page.
    if (window.state === "inactive") continue;
    const candidate: RunWindow = { run, window };
    best = best ? preferredRunWindow(best, candidate) : candidate;
  }
  return { runIds, featuredRun: best };
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
  /**
   * True when the run this course would send an applicant to is an
   * OPEN-ENROLMENT run, which has no application form at all.
   *
   * The apply page redirects on it rather than rendering a form: people get
   * onto an open run by picking a session on the course page, and the apply
   * route refuses a POST against one. Before this flag existed the page read
   * the window through `courseRunWindow()`, so an open run sitting in
   * `applications-closed` or `running` reported `open` and rendered a live
   * form whose submit the route then turned away.
   */
  openEnrol: boolean;
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

  // OPEN ENROLMENT short-circuits everything below. There is no application
  // to show, no availability to tick, and no form to render, so the group
  // read is skipped too and the page sends the visitor to the course page
  // where the session picker lives.
  if (run.enrolMode === "open") {
    return { course, run, window, groups: [], openEnrol: true };
  }

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

  return { course, run, window, groups: rows.map((r) => r.option), openEnrol: false };
}
