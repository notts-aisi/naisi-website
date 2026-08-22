import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { asUidList } from "@/lib/firestore/events";
import { normalizeCourseWeek } from "@/lib/firestore/courses";
import {
  COURSE_MATERIAL_NOTES_COLLECTION,
  normalizeCourseMaterialNote,
} from "@/lib/firestore/courseMaterialNotes";
import {
  RETRO_ANONYMITY_FLOOR,
  RETRO_NOTES_LIMIT,
  RETRO_PROGRESS_LIMIT,
  aggregateRetrospective,
  type MaterialRetroRow,
  type RetroProgressRow,
} from "@/lib/firestore/courseTemplates";

/**
 * THE RETROSPECTIVE — per-material evidence for one run (v2 decision 3): how
 * the cohort rated each piece of material, how many finished it, and what the
 * facilitators wrote about how it landed.
 *
 * WHO MAY READ: admins ∪ `approveCourse` ∪ `draftCourse` ∪ this run's track
 * leads. The people who author and steer curricula, which is the entire point
 * — this view exists to be read while drafting the next version.
 *
 * ── THE ANONYMITY BOUNDARY ──────────────────────────────────────────────────
 * RATINGS ARE ANONYMOUS AGGREGATES. Members rate materials from inside their
 * own progress rows on the understanding that nobody is reading their score
 * as theirs, and the audience for this view is exactly the facilitators and
 * leads who could put a name to a number in a group of eight. So:
 *
 *  - not one uid, name or email of a RATER crosses this boundary. The
 *    aggregation receives a field-masked projection (`itemId`, `rating`,
 *    `completed`) and returns counts;
 *  - `avgRating` is WITHHELD below `RETRO_ANONYMITY_FLOOR` ratings — with one
 *    or two scores an average is invertible by anyone who knows who did the
 *    reading. The count is still shown, because "2 ratings, no average yet"
 *    identifies nobody and is the honest reason the number is missing;
 *  - the ONLY names in the payload belong to FACILITATORS, on notes they
 *    wrote in their staff capacity and signed.
 *
 * Every field added below must be checked against that line. If a future
 * version wants "who hasn't finished week 3", it is a different route with a
 * different tier — not a column here.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## Read cost
 *
 * ONE query per collection for the whole run — progress (field-masked,
 * capped), notes (capped), the run's weeks — plus one count aggregation for
 * the enrolment denominator. Everything is grouped in memory by
 * `aggregateRetrospective`. There is deliberately no per-material and no
 * per-member query: a 12-week course with 10 items a week would be 120 round
 * trips per page view. Past `RETRO_PROGRESS_LIMIT` rows the payload says
 * `truncated: true` rather than averaging a prefix and calling it the cohort.
 *
 * All filters are single equalities on `runId` (automatic single-field index)
 * or an equality pair served by index merging. No composite index was added.
 */

export type RetrospectivePayload = {
  run: {
    id: string;
    label: string;
    courseId: string;
    courseTitle: string;
    /** Provenance: which snapshot this run's curriculum came from, if any. */
    templateId: string | null;
    templateLabel: string | null;
  };
  /** Active enrolments — the denominator on every row. */
  enrolledCount: number;
  /** Averages appear only at or above this many ratings. See the boundary. */
  ratingFloor: number;
  /** True when the run has more progress rows than one read may pull. */
  truncated: boolean;
  materials: MaterialRetroRow[];
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // The staff tier is decidable without touching the database; only the
  // track-lead branch needs the run doc, because that is where the array
  // lives. So the run is read first and the ORDER OF REFUSALS is arranged so
  // an unauthorised caller learns nothing from which one they get: a
  // non-staff caller gets the same 403 whether the run is missing or simply
  // isn't theirs, and the 404 is reachable only once authority is settled.
  const runSnap = await db.collection("courseRuns").doc(runId).get();
  const staff =
    actor.role === "admin" ||
    actor.permissions.approveCourse ||
    actor.permissions.draftCourse;
  if (!staff) {
    const isLead =
      runSnap.exists &&
      asUidList((runSnap.data() ?? {}).trackLeadUids).includes(actor.uid);
    if (!isLead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const runRaw = runSnap.data() ?? {};

  const [weekSnap, progressSnap, noteSnap, enrolledAgg] = await Promise.all([
    db.collection("courseRuns").doc(runId).collection("weeks").get(),
    // FIELD-MASKED on purpose: `publicComment`, `privateNote`, `uid` and the
    // moderation stamps are all on a progress row and none of them belong in
    // an anonymous aggregate. The projection is the boundary, in code.
    db
      .collection("courseProgress")
      .where("runId", "==", runId)
      .select("itemId", "rating", "completed")
      .limit(RETRO_PROGRESS_LIMIT)
      .get(),
    db
      .collection(COURSE_MATERIAL_NOTES_COLLECTION)
      .where("runId", "==", runId)
      .limit(RETRO_NOTES_LIMIT)
      .get(),
    db
      .collection("courseEnrolments")
      .where("runId", "==", runId)
      .where("status", "==", "active")
      .count()
      .get(),
  ]);

  const weeks = weekSnap.docs.map((d) => normalizeCourseWeek(d.id, d.data() ?? {}));
  const progress: RetroProgressRow[] = progressSnap.docs.map((d) => {
    const raw = d.data() ?? {};
    return {
      itemId: typeof raw.itemId === "string" ? raw.itemId : "",
      rating: typeof raw.rating === "number" ? raw.rating : null,
      completed: raw.completed === true,
    };
  });
  const notes = noteSnap.docs.map((d) =>
    normalizeCourseMaterialNote(d.id, d.data() ?? {}),
  );
  const enrolledCount = enrolledAgg.data().count;

  const payload: RetrospectivePayload = {
    run: {
      id: runId,
      label: typeof runRaw.label === "string" ? runRaw.label : "",
      courseId: typeof runRaw.courseId === "string" ? runRaw.courseId : "",
      courseTitle: typeof runRaw.courseTitle === "string" ? runRaw.courseTitle : "",
      templateId: typeof runRaw.templateId === "string" ? runRaw.templateId : null,
      templateLabel:
        typeof runRaw.templateLabel === "string" ? runRaw.templateLabel : null,
    },
    enrolledCount,
    ratingFloor: RETRO_ANONYMITY_FLOOR,
    truncated: progressSnap.size >= RETRO_PROGRESS_LIMIT,
    materials: aggregateRetrospective({ weeks, progress, notes, enrolledCount }),
  };

  return NextResponse.json(payload);
}
