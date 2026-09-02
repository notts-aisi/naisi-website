import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeAdmissionRound } from "@/lib/firestore/admissionRounds";
import { normalizeCourseRun, type CourseRunDoc } from "@/lib/firestore/courses";
import { pickLiveRound, type LiveRoundCandidate } from "@/lib/admissions/liveRound";
import type { RoundWindowState } from "@/lib/admissions/window";

/**
 * Server-only fetcher for the round a course's public page speaks about
 * (`fetchCourses.ts` pattern, and the same standing obligation).
 *
 * ## The obligation, restated because this file inherits it
 *
 * `admissionRounds` is `allow read, write: if false` — read:false as well,
 * because the doc carries live `applicationCounts`, the `finalDeciderUid` who
 * decides your application, and the `criteria` reviewers score against. This
 * reads through the Admin SDK, so rules provide no defence here at all.
 * VISIBILITY IS THIS FILE'S TO ENFORCE, and it does it by PROJECTION rather
 * than by discipline: the return type below carries five fields, all of them
 * dates or a state, and there is no path by which a whole `AdmissionRoundDoc`
 * reaches a renderer. A future field added to the round document is therefore
 * private by default, which is the correct default for this collection.
 *
 * The round's own `label` is deliberately NOT among them. It is the
 * admin-facing handle ("autumn intake v2 DO NOT OPEN"), the same class of
 * string as `courseRuns.label` that V3 stopped showing visitors.
 *
 * ## Why the query is backwards
 *
 * `courseRuns.admissionRoundIds` (the forward pointer) does not exist yet, so
 * the join is walked from the round: `outcomeRunIds` array-contains-any the
 * course's run ids. `array-contains-any` is a single-field index Firestore
 * provisions automatically, so this needs no composite index, and the site
 * runs a handful of rounds a year over a handful of runs per course.
 */

/**
 * The round as a STRANGER may see it. Five printable fields, every one of them
 * something the page shows: when the form opens, when it shuts, and when a
 * decision is promised. Plus the run ids, which are not printable at all.
 */
export type CourseLiveRound = {
  id: string;
  /** Never `inactive`: draft and archived rounds are dropped by the ranking. */
  state: RoundWindowState;
  opensAt: Date | null;
  closesAt: Date | null;
  /** Civil "YYYY-MM-DD", Europe/London. The promise about a day. */
  decisionsByDate: string | null;
  /**
   * The runs this round places people onto, as authored. A LOOKUP KEY, never a
   * rendered string: `roundTargetRun` in `fetchCourses.ts` resolves it against
   * the course's own runs so the page can name the cohort someone is applying
   * FOR, and nothing hands these ids to a component.
   *
   * They earn their place in a deliberately narrow projection because the
   * alternative is worse: without them the page falls back to the featured
   * run, which is by construction never the draft target run an open round
   * places people onto, so the cohort chip and the start date belong to a
   * different intake than the deadline above them.
   */
  outcomeRunIds: string[];
};

/**
 * Firestore's disjunction ceiling for `array-contains-any`. A course with more
 * runs than this is not a case the site has; the slice is here so the query
 * degrades to "the first 30 runs" rather than throwing on a page render.
 */
const MAX_DISJUNCTIONS = 30;

/**
 * The literal rather than `ROUNDS_COLLECTION` from `lib/admissions/roundRoutes`
 * (the `accountDeletion.ts` precedent): that module pulls the whole session and
 * user-permission chain in behind it for one string, and this file is read by a
 * unit test that would then have to stub all of it.
 */
const ROUNDS_COLLECTION = "admissionRounds";

/** Ceiling on the one-off batch read of runs the catalogue did not load. */
const MAX_MISSING_RUN_LOOKUPS = 60;

/**
 * The live round for a set of course run ids, or null when no round names any
 * of them.
 *
 * Null is an ordinary answer, not a failure: it is what every open-enrolment
 * pre-course returns for good, and what an admissions course returns before
 * its intake has been authored. The caller falls back to the run's own window.
 */
export async function fetchLiveRoundForRuns(
  runIds: string[],
  now: Date = new Date(),
): Promise<CourseLiveRound | null> {
  const ids = runIds.filter(Boolean).slice(0, MAX_DISJUNCTIONS);
  if (ids.length === 0) return null;

  const db = getAdminDb();
  if (!db) return null;

  const snap = await db
    .collection(ROUNDS_COLLECTION)
    .where("outcomeRunIds", "array-contains-any", ids)
    .limit(50)
    .get();

  const candidates: RoundCandidate[] = snap.docs.map((doc) =>
    toCandidate(normalizeAdmissionRound(doc.id, doc.data() ?? {})),
  );

  const best = pickLiveRound(candidates, now);
  if (!best) return null;
  return toCourseLiveRound(best.round, best.window);
}

/**
 * The round fields the ranking and the projection between them need. Written
 * once so the two fetchers cannot read a different set.
 */
type RoundCandidate = LiveRoundCandidate & {
  decisionsByDate: string | null;
  outcomeRunIds: string[];
};

/** The one narrowing, applied the moment a round document is read. */
function toCandidate(round: {
  id: string;
  status: RoundCandidate["status"];
  archived: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  decisionsByDate: string | null;
  outcomeRunIds: string[];
}): RoundCandidate {
  return {
    id: round.id,
    status: round.status,
    archived: round.archived,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    decisionsByDate: round.decisionsByDate,
    outcomeRunIds: round.outcomeRunIds,
  };
}

/** The one projection. Both fetchers go through it, so the single-course page
 *  and the catalogue card cannot disagree about what a round exposes. */
function toCourseLiveRound(
  round: RoundCandidate,
  window: { state: RoundWindowState; opensAt: Date | null; closesAt: Date | null },
): CourseLiveRound {
  return {
    id: round.id,
    state: window.state,
    opensAt: window.opensAt,
    closesAt: window.closesAt,
    decisionsByDate: round.decisionsByDate,
    outcomeRunIds: round.outcomeRunIds,
  };
}

/**
 * The live round for MANY courses at once, for the catalogue.
 *
 * The catalogue cannot call `fetchLiveRoundForRuns` per course: it holds a
 * dozen courses and that would be a dozen sequential queries on a page that
 * currently renders in three. So it goes the other way round, reading every
 * round once and posting each to the courses its outcome runs belong to.
 *
 * `knownRuns` is the run documents the caller has already read, by id. Rounds
 * naming a run the caller never loaded (an intake whose target run is still
 * `draft`, which is the normal state of affairs in the fortnight before a
 * term) trigger ONE capped `getAll` for the missing documents rather than a
 * query per round.
 *
 * Those extra documents come BACK to the caller in `runs` rather than being
 * thrown away, because the catalogue needs them for exactly the same reason
 * the single-course page does: the run a round will place people onto is the
 * one whose cohort and start date the card should print, and it is precisely
 * the run the catalogue's own status queries do not return.
 */
export async function listLiveRoundsByCourse(
  knownRuns: Map<string, CourseRunDoc>,
  now: Date = new Date(),
): Promise<{
  /** The live round per course id. Courses with none are simply absent. */
  rounds: Map<string, CourseLiveRound>;
  /** `knownRuns`, plus every run a round named that the caller had not read. */
  runs: Map<string, CourseRunDoc>;
}> {
  const out = new Map<string, CourseLiveRound>();
  const runToCourse = new Map(knownRuns);
  const db = getAdminDb();
  if (!db) return { rounds: out, runs: runToCourse };

  // No `where` clause: the site authors a handful of rounds a year, draft and
  // archived ones are dropped by the ranking anyway, and an equality on
  // `archived` would still return every live round.
  const snap = await db.collection(ROUNDS_COLLECTION).limit(100).get();
  if (snap.empty) return { rounds: out, runs: runToCourse };

  const rounds = snap.docs.map((doc) =>
    normalizeAdmissionRound(doc.id, doc.data() ?? {}),
  );

  // Runs a round names that the caller did not already hold, resolved in one
  // batch read so a term with three fellowship runs costs one round trip.
  const missing = new Set<string>();
  for (const round of rounds) {
    for (const runId of round.outcomeRunIds) {
      if (!runToCourse.has(runId)) missing.add(runId);
    }
  }
  const lookups = [...missing].slice(0, MAX_MISSING_RUN_LOOKUPS);
  if (lookups.length > 0) {
    const docs = await db.getAll(
      ...lookups.map((id) => db.collection("courseRuns").doc(id)),
    );
    for (const doc of docs) {
      if (!doc.exists) continue;
      const run = normalizeCourseRun(doc.id, doc.data() ?? {});
      if (run.courseId) runToCourse.set(doc.id, run);
    }
  }

  // One candidate list per course, then the SAME ranking the single-course
  // fetcher uses. Two surfaces naming two different rounds for one course is
  // the drift a shared helper exists to stop.
  const byCourse = new Map<string, RoundCandidate[]>();
  for (const round of rounds) {
    const courseIds = new Set<string>();
    for (const runId of round.outcomeRunIds) {
      const courseId = runToCourse.get(runId)?.courseId;
      if (courseId) courseIds.add(courseId);
    }
    for (const courseId of courseIds) {
      const list = byCourse.get(courseId) ?? [];
      list.push(toCandidate(round));
      byCourse.set(courseId, list);
    }
  }

  for (const [courseId, candidates] of byCourse) {
    const best = pickLiveRound(candidates, now);
    if (!best) continue;
    out.set(courseId, toCourseLiveRound(best.round, best.window));
  }
  return { rounds: out, runs: runToCourse };
}
