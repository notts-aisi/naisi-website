import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  isValidDateKey,
  type CurrentWeek,
  type WeekPlanEntry,
} from "@/lib/courses/weekPlan";
import {
  memberCurrentWeek,
  resolveCalendar,
  resolveWeekDocs,
} from "@/lib/courses/groupResolve";
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
  sessionModesOf,
  type CourseGroupDoc,
  type GroupSession,
  type GroupSessionMode,
} from "@/lib/firestore/courseGroups";
import {
  normalizeCourseRun,
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
 *
 * ── V2-3: THIS PAYLOAD IS THE MEMBER'S VIEW, NOT THE RUN'S ──────────────────
 * Per-group autonomy (copy-on-write) means a group can run its own calendar
 * and its own version of individual weeks. `run.startDate`, `run.weekPlan`,
 * `run.totalWeeks`, `currentWeek` and the `weeks` index below are therefore
 * all RESOLVED FOR THE CALLER through `groupResolve.ts` — their group's
 * override when it has one, the run canonical otherwise — rather than being
 * the run document's raw fields.
 *
 * That is deliberate and it is the cheap way to hold THE ONE DESIGN RULE:
 * every surface fed by this route (the run home, the WeekRail, the pacing
 * banner, the week page's session date, the Continue CTA) becomes group-aware
 * without any of them learning that groups can diverge. `calendarSource` says
 * WHICH calendar answered so a surface can disclose it; `forkedWeekIds` says
 * which weeks the caller must read out of their group's subcollection instead
 * of the run's (the client SDK can address either, and `useWeek` picks using
 * exactly this list).
 *
 * A caller with no group — unallocated, an admin, a facilitator of two groups
 * — resolves to the run canonical by construction, because `ownGroup` is null
 * and `resolveCalendar(run, null)` is the run's own calendar.
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
  /**
   * HOW EACH WEEK MEETS (v2 decision 7), by week doc id: `{ w03: "virtual" }`.
   * `"virtual"` = the link is the destination and the room is not;
   * `"in-person"` = the reverse; a MISSING key = the facilitator has never set
   * one for that week and the card shows whatever the slot carries (the legacy
   * state, and NOT the same thing as `"in-person"`).
   *
   * THE WHOLE MAP, not the current week's answer, and that is the fix for a
   * real bug: the slot fields above are resolved for ONE week (the current
   * one), but the week page renders ANY week, so a single resolved `mode`
   * rendered week 5's "Online this week" over week 3's evening and hid week
   * 3's room with it. Every surface now picks the week IT is drawing —
   * `WeekView` the viewed week, the run home the current one — through
   * `sessionModesOf`, which is also where the ≤20 bound lives.
   *
   * This travels because the flip is a MEMBER-FACING promise: the facilitator
   * editor says in as many words that switching it "changes what your group
   * sees on the week page and in the reminder emails". Without this field the
   * setting was written, audited and read by nobody but staff.
   *
   * It is NOT a second meeting-link gate, and widening it from one week to all
   * of them does not make it one: a mode is a display fact of the same tier as
   * `sessionLabel`, `meetingUrl` is redacted above by `canSeeMeetingUrl`
   * exactly as before, and a caller who may not see the link still may not see
   * it on a `"virtual"` week.
   */
  sessionModes: Record<string, GroupSessionMode>;
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
    /**
     * Civil date "YYYY-MM-DD" (Europe/London), empty on a half-authored run.
     *
     * THE CALLER'S EFFECTIVE calendar, not necessarily the run's — see the
     * module header. `calendarSource` says which one answered.
     */
    startDate: string;
    weekPlan: WeekPlanEntry[];
    /** Taught weeks in the EFFECTIVE plan (breaks excluded). */
    totalWeeks: number;
  };
  /**
   * Which calendar the three fields above came from. `"group"` means the
   * caller's group has set its own pacing and is no longer tracking the run;
   * surfaces that say "your cohort" should say "your group" when they read it.
   */
  calendarSource: "run" | "group";
  /** Recomputed here on every request; null for a draft/undated run. */
  currentWeek: CurrentWeek | null;
  /**
   * The authored week index the WeekRail draws. `published` is the render
   * gate, not a confidentiality boundary — `courseRuns/{id}/weeks` is
   * signed-in-readable in the rules, so withholding titles here would buy
   * nothing while breaking the rail's "week 6 is ready" affordance.
   *
   * Group forks are laid OVER the canonical index by week id, so a rail row
   * whose group has personalised that week shows the group's title, its
   * estimate and its own `published` flag — the same document the week page
   * will open.
   */
  weeks: Array<{
    id: string;
    weekNumber: number;
    title: string;
    published: boolean;
    estimatedMinutes: number | null;
    /** True when this row came from the caller's group's forked copy. */
    forked: boolean;
  }>;
  /**
   * Week doc ids that exist under `courseGroups/{ownGroup}/weeks` — i.e. the
   * weeks this caller must read from their group rather than from the run.
   * Always empty for a caller with no group of their own.
   *
   * The client CANNOT derive this: a group's forked weeks are the only thing
   * distinguishing "read the fork" from "read the canonical", and a wrong
   * guess shows the wrong curriculum. So the list travels, and `useWeek`
   * resolves against it rather than probing for a document that usually isn't
   * there.
   */
  forkedWeekIds: string[];
  /** The caller's OWN enrolment summary; null when they read as facilitator/admin. */
  enrolment: {
    status: CourseEnrolmentStatus;
    role: CourseEnrolmentRole;
    groupId: string | null;
    joinedWeekNumber: number;
  } | null;
  /**
   * The card the run home has always drawn: the caller's own placement, or the
   * single group they facilitate. Kept for compatibility, and still the group
   * every OTHER field on this payload is resolved through (the calendar, the
   * current week, the week forks).
   */
  group: OverviewGroup | null;
  /**
   * EVERY group this caller has staff or member standing in: their placement
   * first, then each group they facilitate, deduped by id.
   *
   * `group` alone was the bug. A facilitator holding two groups had no
   * "current" one, so the single field was null and the run home drew nothing
   * for the person who most needs it: no roster, no register, no review queue,
   * no group email. Running two sessions is ordinary here, so the payload
   * carries the list and the page draws a card each.
   *
   * Never empty when `group` is set, and `group`, when set, is its first
   * entry.
   */
  groups: OverviewGroup[];
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
  const [runSnap, enrolSnap, groupSnap] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, actor.uid)).get(),
    db.collection("courseGroups").where("runId", "==", runId).limit(50).get(),
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

  // The caller's OWN group: their placement if they have one, otherwise the
  // single group they facilitate. Facilitating two groups leaves this null
  // deliberately: there is no "current" one to resolve a calendar or a week
  // fork through, so those stay run-level. The CARDS are a separate question,
  // answered by `groupCards` below, which does cover that case.
  //
  // RESOLVED BEFORE THE CALENDAR, and that ordering is now load-bearing: the
  // group is the first half of every resolution below it (V2-3).
  const ownGroup =
    (liveEnrolment?.groupId
      ? (groups.find((g) => g.id === liveEnrolment.groupId) ?? null)
      : null) ?? (facilitates.length === 1 ? facilitates[0] : null);

  // GROUP-FIRST, THROUGH THE ONE HELPER. `resolveCalendar` returns the group's
  // pacing override when it has set one and the run's calendar otherwise, so
  // an unallocated member and a group that has never touched its pacing are
  // byte-identical to the pre-V2-3 payload.
  const calendar = resolveCalendar(run, ownGroup);

  // SERVERS ALWAYS RECOMPUTE. A half-authored run (created, no start date
  // chosen) is a legitimate state and the week maths throws on a malformed key
  // by design, so the guard is required, not defensive noise — and it guards
  // the RESOLVED date, since a group's own start date is just as capable of
  // being half-authored as the run's.
  const currentWeek =
    run.status !== "draft" && isValidDateKey(calendar.startDate)
      ? memberCurrentWeek(run, ownGroup)
      : null;

  /**
   * Every group that earns a card, in the order they are drawn: the caller's
   * own placement first (so a learner who also facilitates still leads with
   * their own room), then each group they facilitate, deduped by id.
   */
  const groupCards: CourseGroupDoc[] = [];
  const seenGroupIds = new Set<string>();
  for (const candidate of [ownGroup, ...facilitates]) {
    if (!candidate || seenGroupIds.has(candidate.id)) continue;
    seenGroupIds.add(candidate.id);
    groupCards.push(candidate);
  }

  // Per group, not once: an admin sees every link, a member sees their own
  // room's, and a facilitator sees the link for each room they hold. The
  // answer for `ownGroup` is byte-identical to what it was before.
  const canSeeMeetingUrlFor = (group: CourseGroupDoc): boolean =>
    isAdmin ||
    (liveEnrolment?.status === "active" && liveEnrolment.groupId === group.id) ||
    group.facilitatorUids.includes(actor.uid);

  // The union across every card, deduped, so two groups sharing a facilitator
  // cost one user read rather than two.
  const facilitatorUids = [
    ...new Set(groupCards.flatMap((group) => group.facilitatorUids)),
  ];
  // One round trip for both: the facilitator names and the caller's own week
  // index, canonical with their group's forks laid over it by doc id. The fork
  // read is scoped to the ONE group this caller belongs to (never the run's
  // groups), so a member learns nothing about how anybody else's room has been
  // personalised.
  //
  // `resolveWeekDocs` is THE overlay — the same one every other week reader
  // resolves through — rather than a second merge written out here. A forked
  // week REPLACES its canonical row (same id, same number, the group's own
  // title and published flag), which is what makes the rail agree with the
  // page each row links to.
  const [userDocs, weekEntries] = await Promise.all([
    facilitatorUids.length
      ? db.getAll(...facilitatorUids.map((uid) => db.collection("users").doc(uid)))
      : Promise.resolve([]),
    resolveWeekDocs(db, runId, ownGroup?.id ?? null),
  ]);
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  const forkedWeekIds: string[] = [];
  const weeks = weekEntries
    .map(({ source, week: w }) => {
      if (source === "group") forkedWeekIds.push(w.id);
      return {
        id: w.id,
        weekNumber: w.weekNumber,
        title: w.title,
        published: w.published,
        estimatedMinutes: w.estimatedMinutes,
        forked: source === "group",
      };
    })
    .sort((a, b) => a.weekNumber - b.weekNumber || a.id.localeCompare(b.id));

  // ONE week key for the slot fields, which describe the session the run home
  // is about to name, which is the CURRENT one. The modes deliberately do NOT
  // collapse to this key: see `sessionModes` on the wire type. A surface that
  // draws another week reads that map and gets the room-vs-link swap for the
  // week it is actually showing.
  const weekId = currentWeekId(currentWeek);
  const toCard = (source: CourseGroupDoc): OverviewGroup => {
    const session = sessionForWeek(source, weekId);
    return {
      id: source.id,
      name: source.name,
      sessionLabel: sessionLabel(session),
      weekday: session.weekday,
      startTimeLocal: session.startTimeLocal,
      durationMinutes: session.durationMinutes,
      location: session.location,
      meetingUrl: canSeeMeetingUrlFor(source) ? session.meetingUrl : null,
      sessionModes: sessionModesOf(source),
      facilitatorNames: source.facilitatorUids.map(
        (uid) => nameByUid.get(uid) ?? "NAISI member",
      ),
    };
  };

  const groupCardPayloads = groupCards.map(toCard);
  // `group` is the first card when there is one, which for every caller who
  // had a card before is the same object they had before.
  const group: OverviewGroup | null =
    (ownGroup ? groupCardPayloads.find((c) => c.id === ownGroup.id) : null) ?? null;

  const payload: OverviewPayload = {
    run: {
      id: run.id,
      courseId: run.courseId,
      courseTitle: run.courseTitle,
      label: run.label,
      academicYear: run.academicYear,
      status: run.status,
      // THE RESOLVED calendar, not the run document's own — see the module
      // header. Identical to the run's for every caller without a group that
      // has overridden its pacing.
      startDate: calendar.startDate,
      weekPlan: calendar.weekPlan,
      totalWeeks: calendar.weekPlan.filter((entry) => entry.kind === "week").length,
    },
    calendarSource: calendar.source,
    currentWeek,
    weeks,
    forkedWeekIds,
    enrolment: enrolment
      ? {
          status: enrolment.status,
          role: enrolment.role,
          groupId: enrolment.groupId,
          joinedWeekNumber: enrolment.joinedWeekNumber,
        }
      : null,
    group,
    groups: groupCardPayloads,
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
