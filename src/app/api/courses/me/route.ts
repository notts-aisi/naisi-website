import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { currentWeekFor, isValidDateKey } from "@/lib/courses/weekPlan";
import {
  normalizeCourseEnrolment,
  type CourseEnrolmentDoc,
} from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import {
  normalizeCourseRun,
  type CourseRunDoc,
  type CourseRunStatus,
} from "@/lib/firestore/courses";

/**
 * "Every run you touch" — the payload behind the `/learn` hub.
 *
 * WHO MAY READ: any signed-in caller, about THEMSELVES only. There is no uid
 * parameter and no way to ask about someone else: the three queries below are
 * each scoped to `actor.uid`, so the route is enumeration-safe by construction.
 *
 * Four ways a run reaches this list, merged into one row per run because one
 * person can hold several of them at once (a track lead who also facilitates a
 * group, a reviewer who is learning on the run they help admit for):
 *
 *   learner / facilitator  — a `courseEnrolments` row (facilitators get one
 *                            when they are staffed onto a group, which is why
 *                            "every run you touch" is ONE enrolment query)
 *   reviewer               — named in `courseRuns.admissionsReviewerUids`
 *   lead                   — named in `courseRuns.trackLeadUids`
 *
 * Holding a role here grants NOTHING beyond this hub row: admissions is a
 * separate lane from the cohort (see the applications route), so a reviewer's
 * card links to the queue, never to the learning space. The overview route
 * enforces that boundary independently — this payload is a list of doors, not
 * a set of keys.
 *
 * PII: names never travel at all (nobody but the caller is named), and the one
 * cross-collection lookup is a group NAME. No emails, no cohort rosters.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the /learn hub renders from)
// ---------------------------------------------------------------------------

export type MyRunRole = "learner" | "facilitator" | "reviewer" | "lead";

export type MyRunEntry = {
  runId: string;
  courseId: string;
  courseTitle: string;
  label: string;
  academicYear: string;
  status: CourseRunStatus;
  /** Every role the caller holds on this run, in `ROLE_ORDER`. */
  roles: MyRunRole[];
  /**
   * Recomputed server-side on every request (there is no cron; the current
   * week is a pure function of the run's civil dates — see weekPlan.ts). Null
   * for a draft run or one whose `startDate` is not yet a valid civil date.
   */
  currentWeek: {
    phase: "before" | "running" | "after";
    /** Null during a break and outside the run. */
    weekNumber: number | null;
    /** Last taught week that has STARTED; 0 before the run begins. */
    anchorWeekNumber: number;
    breakLabel: string | null;
  } | null;
  /** Taught weeks in the plan (breaks excluded). */
  totalWeeks: number;
  /** Only ever the caller's OWN group, and only when they are enrolled in one. */
  groupName: string | null;
};

export type MePayload = { runs: MyRunEntry[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render order for the role chips, so a row never reshuffles between loads. */
const ROLE_ORDER: MyRunRole[] = ["learner", "facilitator", "reviewer", "lead"];

/**
 * Hub ordering: what you are doing now, then what you are waiting on, then
 * history. Ranks rather than a chain of comparators so the intent survives a
 * new status being added to the lifecycle.
 */
const STATUS_RANK: Record<CourseRunStatus, number> = {
  running: 0,
  "applications-open": 1,
  "applications-closed": 1,
  completed: 2,
  draft: 3,
  cancelled: 3,
};

/**
 * The hub's slice of `currentWeekFor` — phase, week, anchor, break label.
 *
 * `startDate` is validated at write time by the run normaliser, but a run can
 * legitimately be half-authored (created, no date chosen yet), and
 * `currentWeekFor` THROWS on a malformed key by design. Guarding with
 * `isValidDateKey` is what the week-maths module header asks of render paths.
 */
function currentWeekSummary(run: CourseRunDoc): MyRunEntry["currentWeek"] {
  if (run.status === "draft" || !isValidDateKey(run.startDate)) return null;
  const cw = currentWeekFor({ startDate: run.startDate, weekPlan: run.weekPlan });
  return {
    phase: cw.phase,
    weekNumber: cw.weekNumber,
    anchorWeekNumber: cw.anchorWeekNumber,
    breakLabel: cw.breakLabel,
  };
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET() {
  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // Three scoped queries, one per way a run can reach the hub. `withdrawn` and
  // `removed` enrolments are excluded at the query: leaving a run removes it
  // from your hub, and the composite (uid, status) index makes that free.
  // `completed` stays — a finished cohort is history you can still open.
  const [enrolSnap, reviewerSnap, leadSnap] = await Promise.all([
    db
      .collection("courseEnrolments")
      .where("uid", "==", actor.uid)
      .where("status", "in", ["active", "completed"])
      .limit(50)
      .get(),
    db
      .collection("courseRuns")
      .where("admissionsReviewerUids", "array-contains", actor.uid)
      .limit(50)
      .get(),
    db
      .collection("courseRuns")
      .where("trackLeadUids", "array-contains", actor.uid)
      .limit(50)
      .get(),
  ]);

  const enrolments: CourseEnrolmentDoc[] = enrolSnap.docs.map((d) =>
    normalizeCourseEnrolment(d.id, d.data() ?? {}),
  );

  // The role queries already carry their run docs; only the enrolments need a
  // lookup, and only for runs the other two didn't already return.
  const runById = new Map<string, CourseRunDoc>();
  for (const doc of [...reviewerSnap.docs, ...leadSnap.docs]) {
    if (!runById.has(doc.id)) {
      runById.set(doc.id, normalizeCourseRun(doc.id, doc.data() ?? {}));
    }
  }
  const missingRunIds = [
    ...new Set(
      enrolments.map((e) => e.runId).filter((id) => id && !runById.has(id)),
    ),
  ];
  const missingRunSnaps = missingRunIds.length
    ? await db.getAll(
        ...missingRunIds.map((id) => db.collection("courseRuns").doc(id)),
      )
    : [];
  for (const snap of missingRunSnaps) {
    if (snap.exists) runById.set(snap.id, normalizeCourseRun(snap.id, snap.data() ?? {}));
  }

  type Merged = {
    run: CourseRunDoc;
    roles: Set<MyRunRole>;
    enrolment: CourseEnrolmentDoc | null;
  };
  const merged = new Map<string, Merged>();
  const ensure = (run: CourseRunDoc): Merged => {
    const existing = merged.get(run.id);
    if (existing) return existing;
    const fresh: Merged = { run, roles: new Set<MyRunRole>(), enrolment: null };
    merged.set(run.id, fresh);
    return fresh;
  };

  for (const enrolment of enrolments) {
    // A run deleted out from under an enrolment has nothing to render.
    const run = runById.get(enrolment.runId);
    if (!run) continue;
    const entry = ensure(run);
    entry.enrolment = enrolment;
    entry.roles.add(enrolment.role === "facilitator" ? "facilitator" : "learner");
  }
  for (const doc of reviewerSnap.docs) {
    ensure(runById.get(doc.id) ?? normalizeCourseRun(doc.id, doc.data() ?? {})).roles.add(
      "reviewer",
    );
  }
  for (const doc of leadSnap.docs) {
    ensure(runById.get(doc.id) ?? normalizeCourseRun(doc.id, doc.data() ?? {})).roles.add(
      "lead",
    );
  }

  // One `getAll` for every group name the hub needs — the caller's own
  // placements and nothing else.
  const groupIds = [
    ...new Set(
      [...merged.values()]
        .map((m) => m.enrolment?.groupId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const groupSnaps = groupIds.length
    ? await db.getAll(...groupIds.map((id) => db.collection("courseGroups").doc(id)))
    : [];
  const groupNameById = new Map<string, string>();
  for (const snap of groupSnaps) {
    if (!snap.exists) continue;
    groupNameById.set(snap.id, normalizeCourseGroup(snap.id, snap.data() ?? {}).name);
  }

  const runs: MyRunEntry[] = [...merged.values()].map(({ run, roles, enrolment }) => ({
    runId: run.id,
    courseId: run.courseId,
    courseTitle: run.courseTitle,
    label: run.label,
    academicYear: run.academicYear,
    status: run.status,
    roles: ROLE_ORDER.filter((role) => roles.has(role)),
    currentWeek: currentWeekSummary(run),
    totalWeeks: run.weekPlan.filter((entry) => entry.kind === "week").length,
    groupName: enrolment?.groupId ? (groupNameById.get(enrolment.groupId) ?? null) : null,
  }));

  runs.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.label.localeCompare(b.label) ||
      // Total order, so two runs sharing a label never swap between loads.
      a.runId.localeCompare(b.runId),
  );

  const payload: MePayload = { runs };
  return NextResponse.json(payload);
}
