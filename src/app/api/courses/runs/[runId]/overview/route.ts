import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  currentWeekFor,
  isValidDateKey,
  type CurrentWeek,
  type WeekPlanEntry,
} from "@/lib/courses/weekPlan";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
  type CourseEnrolmentDoc,
  type CourseEnrolmentRole,
  type CourseEnrolmentStatus,
} from "@/lib/firestore/courseEnrolments";
import {
  normalizeCourseGroup,
  sessionForWeek,
  type CourseGroupDoc,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import {
  normalizeCourseRun,
  normalizeCourseWeek,
  weekDocId,
  type CourseRunStatus,
} from "@/lib/firestore/courses";

/**
 * The learning space's one round trip: everything `/learn/[runId]` needs to
 * render — the run, its recomputed current week, the week index the WeekRail
 * draws, the caller's own enrolment, and their group's session card.
 *
 * ── WHO MAY READ (locked product decision) ──────────────────────────────────
 * Enrolled members of the run ∪ its facilitators ∪ admins. Admissions
 * reviewers and TRACK LEADS get 403 unless they also hold one of those:
 * admissions is a separate lane from the cohort, and staffing a run is not
 * membership of it. A track lead who wants the cohort view gets a facilitator
 * enrolment like everyone else. This is the same boundary the applications
 * route states from the other side — reviewing applications grants no access
 * to the cohort, facilitating grants no sight of applications.
 *
 * `completed` enrolments read too: a finished cohort is the member's own
 * history, and nothing here is more sensitive to them than it was on their
 * last active day. Writing is unaffected — the courseProgress rules gate the
 * check-off path on an ACTIVE enrolment, so a completed run is read-only by
 * construction rather than by a flag in this payload.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ────────────────────────────────────────────
 * `courseGroups` is read-locked to the authoring tier in firestore.rules
 * because group docs carry the MEETING LINK; an enumerable meet link is an
 * open door onto a cohort call. So a member's own group card cannot come from
 * the client SDK — it comes from here, scoped to the one group they belong to,
 * with `meetingUrl` gated separately below.
 *
 * PII: facilitators travel as NAMES only (displayNameOf, never an email), and
 * no other member of the cohort appears in this payload at all.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the run home renders from)
// ---------------------------------------------------------------------------

export type OverviewGroup = {
  id: string;
  name: string;
  /** e.g. "Tuesdays 18:00–19:30"; empty when the slot isn't set up yet. */
  sessionLabel: string;
  /** 0 = Sunday .. 6 = Saturday (JS `Date.getDay()` convention). */
  weekday: number;
  /** Wall-clock start in Europe/London, "HH:MM" 24h. */
  startTimeLocal: string;
  durationMinutes: number;
  location: string;
  /**
   * Null unless the caller is an active member of THIS group, a facilitator of
   * it, or an admin — see `canSeeMeetingUrl` below. Also null when the group
   * simply meets in person.
   */
  meetingUrl: string | null;
  /** Names only. */
  facilitatorNames: string[];
};

export type OverviewPayload = {
  run: {
    id: string;
    courseId: string;
    courseTitle: string;
    label: string;
    academicYear: string;
    status: CourseRunStatus;
    /** Civil date "YYYY-MM-DD" (Europe/London), empty on a half-authored run. */
    startDate: string;
    weekPlan: WeekPlanEntry[];
    /** Taught weeks in the plan (breaks excluded). */
    totalWeeks: number;
  };
  /** Recomputed here on every request; null for a draft/undated run. */
  currentWeek: CurrentWeek | null;
  /**
   * The authored week index the WeekRail draws. `published` is the render
   * gate, not a confidentiality boundary — `courseRuns/{id}/weeks` is
   * signed-in-readable in the rules, so withholding titles here would buy
   * nothing while breaking the rail's "week 6 is ready" affordance.
   */
  weeks: Array<{
    id: string;
    weekNumber: number;
    title: string;
    published: boolean;
    estimatedMinutes: number | null;
  }>;
  /** The caller's OWN enrolment summary; null when they read as facilitator/admin. */
  enrolment: {
    status: CourseEnrolmentStatus;
    role: CourseEnrolmentRole;
    groupId: string | null;
    joinedWeekNumber: number;
  } | null;
  group: OverviewGroup | null;
  access: {
    isAdmin: boolean;
    /** An active or completed LEARNER enrolment — `enrolment.status` distinguishes. */
    isEnrolled: boolean;
    isFacilitator: boolean;
    isReviewer: boolean;
    isTrackLead: boolean;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Index = `GroupSession.weekday` (`Date.getDay()`, 0 = Sunday). */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function endTimeLabel(start: string, minutes: number): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m || minutes <= 0) return null;
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * "Tuesdays 18:00–19:30" — byte-for-byte the label the apply page, the
 * admissions queue and the allocation board render, so a member reads the same
 * string everywhere their slot appears. Deliberately duplicated: route
 * handlers don't import from one another (the plan's integration checklist
 * owns the eventual shared extraction). The format is the contract; change all
 * copies together.
 */
function sessionLabel(session: GroupSession): string {
  const day = WEEKDAY_NAMES[session.weekday];
  if (!day || !session.startTimeLocal) return "";
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  return `${day}s ${session.startTimeLocal}${end ? `–${end}` : ""}`;
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address, which is what makes this safe
 * for a member-facing payload. (Same local helper P1/P5/P6 carry.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

/**
 * The week id whose session override applies right now. Breaks and the
 * before/after phases have no week doc of their own, so they fall back to the
 * anchor (the last taught week that started) — a cohort on reading week still
 * sees the slot it will return to. An empty string means "no override", which
 * `sessionForWeek` resolves to the recurring slot.
 */
function currentWeekId(currentWeek: CurrentWeek | null): string {
  if (!currentWeek) return "";
  const n = currentWeek.weekNumber ?? currentWeek.anchorWeekNumber;
  return n >= 1 ? weekDocId(n) : "";
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // One round trip for all four reads — this is the run home's only fetch, and
  // the access decision below needs three of them anyway (the group query
  // resolves group-level facilitation, which the run's arrays don't cover).
  // Nothing is returned before the 403; the payload is the boundary, not the
  // individual reads.
  //
  // The enrolment is addressed by construction (`courseEnrolmentId`), never
  // by query — one doc read, and no way to spell another member's row.
  const [runSnap, enrolSnap, groupSnap, weekSnap] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, actor.uid)).get(),
    db.collection("courseGroups").where("runId", "==", runId).limit(50).get(),
    // Week ids are "w01".."w60", so default `__name__` order already is week
    // order; no `orderBy` on `weekNumber`, which a half-authored doc may lack.
    db.collection("courseRuns").doc(runId).collection("weeks").limit(60).get(),
  ]);

  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const enrolment: CourseEnrolmentDoc | null = enrolSnap.exists
    ? normalizeCourseEnrolment(enrolSnap.id, enrolSnap.data() ?? {})
    : null;
  // Withdrawn / removed enrolments lose access the moment they are written,
  // whatever the member's open tab still shows.
  const liveEnrolment =
    enrolment && (enrolment.status === "active" || enrolment.status === "completed")
      ? enrolment
      : null;

  const groups: CourseGroupDoc[] = groupSnap.docs
    .map((d) => normalizeCourseGroup(d.id, d.data() ?? {}))
    .filter((g) => !g.archived);
  const facilitates = groups.filter((g) => g.facilitatorUids.includes(actor.uid));

  const isAdmin = actor.role === "admin";
  const isEnrolled = liveEnrolment?.role === "learner";
  // Three routes to facilitator access: staffed onto a group (the usual one —
  // the facilitators route upserts a `role: "facilitator"` enrolment at the
  // same time), named on the run itself, or holding the group directly.
  const isFacilitator =
    (liveEnrolment?.role === "facilitator" && liveEnrolment.status === "active") ||
    run.runFacilitatorUids.includes(actor.uid) ||
    facilitates.length > 0;
  const isReviewer = run.admissionsReviewerUids.includes(actor.uid);
  const isTrackLead = run.trackLeadUids.includes(actor.uid);

  // Reviewer and track lead are deliberately NOT access grants here.
  if (!isAdmin && !liveEnrolment && !isFacilitator) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // SERVERS ALWAYS RECOMPUTE. A half-authored run (created, no start date
  // chosen) is a legitimate state and `currentWeekFor` throws on a malformed
  // key by design, so the guard is required, not defensive noise.
  const currentWeek =
    run.status !== "draft" && isValidDateKey(run.startDate)
      ? currentWeekFor({ startDate: run.startDate, weekPlan: run.weekPlan })
      : null;

  const weeks = weekSnap.docs
    .map((d) => normalizeCourseWeek(d.id, d.data() ?? {}))
    .map((w) => ({
      id: w.id,
      weekNumber: w.weekNumber,
      title: w.title,
      published: w.published,
      estimatedMinutes: w.estimatedMinutes,
    }))
    .sort((a, b) => a.weekNumber - b.weekNumber || a.id.localeCompare(b.id));

  // The card is the caller's OWN group: their placement if they have one,
  // otherwise the single group they facilitate. Facilitating two groups yields
  // no card — there is no "current" one to show, and the roster route is the
  // per-group surface.
  const ownGroup =
    (liveEnrolment?.groupId
      ? (groups.find((g) => g.id === liveEnrolment.groupId) ?? null)
      : null) ?? (facilitates.length === 1 ? facilitates[0] : null);

  // Stated as its own predicate rather than left implicit: every future edit to
  // how `ownGroup` is chosen has to answer this question again.
  const canSeeMeetingUrl =
    isAdmin ||
    Boolean(
      ownGroup &&
        ((liveEnrolment?.status === "active" && liveEnrolment.groupId === ownGroup.id) ||
          ownGroup.facilitatorUids.includes(actor.uid)),
    );

  const facilitatorUids = ownGroup?.facilitatorUids ?? [];
  const userDocs = facilitatorUids.length
    ? await db.getAll(...facilitatorUids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  let group: OverviewGroup | null = null;
  if (ownGroup) {
    const session = sessionForWeek(ownGroup, currentWeekId(currentWeek));
    group = {
      id: ownGroup.id,
      name: ownGroup.name,
      sessionLabel: sessionLabel(session),
      weekday: session.weekday,
      startTimeLocal: session.startTimeLocal,
      durationMinutes: session.durationMinutes,
      location: session.location,
      meetingUrl: canSeeMeetingUrl ? session.meetingUrl : null,
      facilitatorNames: facilitatorUids.map(
        (uid) => nameByUid.get(uid) ?? "NAISI member",
      ),
    };
  }

  const payload: OverviewPayload = {
    run: {
      id: run.id,
      courseId: run.courseId,
      courseTitle: run.courseTitle,
      label: run.label,
      academicYear: run.academicYear,
      status: run.status,
      startDate: run.startDate,
      weekPlan: run.weekPlan,
      totalWeeks: run.weekPlan.filter((entry) => entry.kind === "week").length,
    },
    currentWeek,
    weeks,
    enrolment: enrolment
      ? {
          status: enrolment.status,
          role: enrolment.role,
          groupId: enrolment.groupId,
          joinedWeekNumber: enrolment.joinedWeekNumber,
        }
      : null,
    group,
    access: {
      isAdmin,
      isEnrolled,
      isFacilitator,
      isReviewer,
      isTrackLead,
    },
  };

  return NextResponse.json(payload);
}
