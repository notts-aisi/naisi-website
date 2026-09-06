import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import type { CurrentWeek, WeekPlanEntry } from "@/lib/courses/weekPlan";
import {
  resolveGroupCalendar,
  resolveGroupCalendars,
  resolveWeekDocs,
  type GroupCalendar,
  type WeekSource,
} from "@/lib/courses/groupResolve";
import { resolveSessions, sessionRange } from "@/lib/courses/sessions";
import {
  ownAttendanceSessions,
  sessionsFromJoinWeek,
  type OwnAttendanceSession,
} from "@/lib/courses/ownAttendance";
import { attendanceDocId } from "@/lib/firestore/courseAttendance";
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
 *
 * ── ONE CALENDAR PER GROUP, NOT ONE PER CALLER ──────────────────────────────
 * The paragraph above is still true of the TOP-LEVEL fields, and it was once
 * the whole story: the page drew at most one group card, so the caller's
 * calendar and that card's calendar were the same object. They are not the
 * same thing, and a facilitator holding two groups is where the difference
 * shows. Their `ownGroup` is null, so every top-level field resolves to the
 * run canonical, and a card drawn off that would show a group three weeks
 * behind the run its own start date, its own week number and the wrong week's
 * session override, twice, identically, with nothing on the page to say which
 * of the two rooms was being described.
 *
 * So every entry in `groups[]` carries its OWN resolved calendar
 * (`OverviewGroup.calendar`) and every slot field on that entry is resolved
 * through it. `resolveGroupCalendar` is the same helper the singular path
 * uses, called once per group on one clock.
 *
 * `group` (singular) stays NULL for a multi-group facilitator rather than
 * becoming `groups[0]`. `ownGroup` is resolved BEFORE the calendar and that
 * ordering is load-bearing: picking an arbitrary group there would anchor the
 * whole run home, the rail, the pacing banner and the week forks to one of
 * two rooms.
 *
 * ── THE CALLER'S OWN ATTENDANCE ─────────────────────────────────────────────
 * `ownAttendance` is a learner's own row out of their group's registers, and
 * it is the only place a member ever sees one. `courseAttendance` stays
 * `read: if false` because one register holds the whole room's marks plus the
 * facilitator's private notes about named students; `ownAttendanceSessions`
 * projects four fields out of each register and copies nothing.
 *
 * GATED ON `pushedAt`, so a register the facilitator is still filling in
 * during the session is invisible here by construction rather than by a flag
 * a later edit could forget.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the run home renders from)
// ---------------------------------------------------------------------------

/**
 * The next session a group holds that has not finished yet, or null once its
 * term is over. Resolved from `resolveSessions` + `sessionRange`, so a group
 * that meets twice a week gets its NEXT meeting rather than its next week.
 */
export type OverviewNextSession = {
  weekNumber: number;
  /** 1-based. 2 and up are the week's later meetings. */
  occurrence: number;
  /** `sessionKey(weekNumber, occurrence)`, the register's own key. */
  sessionKey: string;
  /** Civil date "YYYY-MM-DD" (Europe/London). Never empty on a next session. */
  dateKey: string;
  /** Wall-clock start in Europe/London, "HH:MM" 24h. */
  startTimeLocal: string;
  durationMinutes: number;
};

/**
 * ONE GROUP'S OWN CALENDAR: the fix this shape exists for.
 *
 * Every group on `groups[]` carries its own, resolved through the group's
 * pacing overrides rather than the caller's. Two groups on different pacing
 * therefore report different current weeks and different date ranges on the
 * same payload, which is what a facilitator holding both needs to read.
 *
 * `source` is the same disclosure `calendarSource` makes at the top level, per
 * group: `"group"` means this room has left the run's clock.
 */
export type OverviewGroupCalendar = {
  source: WeekSource;
  /** Civil date "YYYY-MM-DD", empty on a half-authored calendar. */
  startDate: string;
  /** Taught weeks in THIS group's plan, breaks excluded. */
  totalWeeks: number;
  /** Null on a draft run or one with no usable start date. */
  currentWeek: CurrentWeek | null;
  /** First taught session's civil date, empty when none can be dated. */
  firstSessionDate: string;
  /** Last taught session's civil date, empty when none can be dated. */
  lastSessionDate: string;
  nextSession: OverviewNextSession | null;
};

export type OverviewGroup = {
  id: string;
  name: string;
  /**
   * THIS group's calendar, never the caller's. Every slot field below is
   * resolved through it. See the module header.
   */
  calendar: OverviewGroupCalendar;
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
   * @deprecated Read `groups[]` instead. REMOVED IN PR38, which rebuilds the
   * learn hub's structure and is the last consumer that needs it.
   *
   * The card the run home has always drawn: the caller's own placement, or the
   * single group they facilitate. Still the group the TOP-LEVEL fields are
   * resolved through (the run calendar, `currentWeek`, `forkedWeekIds`), which
   * is why it cannot simply be deleted today.
   *
   * NULL FOR A MULTI-GROUP FACILITATOR, never `groups[0]`. `ownGroup` is the
   * anchor of every top-level resolution below it, so naming one of two rooms
   * here would silently pace the whole page by that room. A caller who wants a
   * group's dates reads them off that group's own `calendar` entry.
   *
   * When set, it is `groups[0]`, but the implication runs one way only.
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
  /**
   * THE CALLER'S OWN ATTENDANCE, and nobody else's. Null for anyone without a
   * live learner enrolment placed in a group: a facilitator, an admin reading
   * over the cohort's shoulder, an unallocated member.
   *
   * `sessions` lists only the sessions whose register has been PUSHED (see the
   * module header); `rollup` is the mirror already stored on the caller's own
   * enrolment row, recomputed by the push. The two can disagree on an unmarked
   * cell on purpose: the rollup counts it as an absence, the session list
   * leaves it null so a page can say "not marked" rather than accuse anyone.
   */
  ownAttendance: {
    sessions: OwnAttendanceSession[];
    rollup: {
      sessionsHeld: number;
      attendedInFull: number;
      late: number;
      leftEarly: number;
      absent: number;
      excused: number;
      lastPushedSessionKey: string | null;
      /** ISO 8601, or null before the first push. */
      lastComputedAt: string | null;
    };
  } | null;
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

/**
 * Read cap on the caller's own registers. A course is a term long, and the
 * week plan is already bounded at 60 entries by the rules, but a group that
 * meets twice a week doubles the session count and this route runs on the page
 * members open daily. Ninety sessions is far past any real cohort and still a
 * bounded `getAll`.
 */
const MAX_OWN_ATTENDANCE_SESSIONS = 90;

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

  // ONE CLOCK for every resolution in this request. Two groups resolved a
  // millisecond apart across a midnight would land in different cohort weeks,
  // and the page would be reporting its own timing rather than their pacing.
  const now = new Date();

  /**
   * Every group that earns a card, in the order they are drawn: the caller's
   * own placement first (so a learner who also facilitates still leads with
   * their own room), then each group they facilitate, deduped by id.
   *
   * Built BEFORE the calendars because it is the list they are resolved over.
   */
  const groupCards: CourseGroupDoc[] = [];
  const seenGroupIds = new Set<string>();
  for (const candidate of [ownGroup, ...facilitates]) {
    if (!candidate || seenGroupIds.has(candidate.id)) continue;
    seenGroupIds.add(candidate.id);
    groupCards.push(candidate);
  }

  /**
   * ONE GROUP'S CALENDAR, THROUGH THE ONE HELPER: resolved ONCE PER GROUP over
   * the card list, plus one run-level resolution for the caller's top-level
   * fields when they hold no group.
   *
   * `resolveGroupCalendars` is that per-group pass, and it is the shared clock
   * in one place rather than a `now` threaded through a closure: every entry in
   * the map was resolved from the same instant, so no card can report the
   * request's timing as pacing. `calendarFor` then READS the map, which is why
   * the caller's own group is resolved once here and not again per card.
   *
   * `resolveGroupCalendar` returns the group's pacing override when it has set
   * one and the run's calendar otherwise, so an unallocated member and a group
   * that has never touched its pacing are byte-identical to the pre-V2-3
   * payload.
   *
   * SERVERS ALWAYS RECOMPUTE, and a half-authored run (created, no start date
   * chosen) is a legitimate state: the helper already returns a null week for
   * an unusable RESOLVED start date, since a group's own start date is just as
   * capable of being half-authored as the run's. The DRAFT suppression is this
   * route's own rule and is applied here so every group gets it identically.
   */
  const groupCalendars = resolveGroupCalendars(run, groupCards, now);
  const scheduled = run.status !== "draft";
  const asScheduled = (resolved: GroupCalendar): GroupCalendar =>
    scheduled ? resolved : { ...resolved, currentWeek: null };
  // The run canonical, for a caller with no group of their own. Resolved once,
  // on the same clock, and never re-derived per card.
  const runCalendar = asScheduled(resolveGroupCalendar(run, null, now));
  const calendarFor = (group: CourseGroupDoc | null): GroupCalendar => {
    if (!group) return runCalendar;
    const resolved = groupCalendars.get(group.id);
    // Every group `calendarFor` is called with is a card, so the map answers.
    return resolved ? asScheduled(resolved) : asScheduled(resolveGroupCalendar(run, group, now));
  };

  const own = calendarFor(ownGroup);
  const calendar = own.calendar;
  const currentWeek = own.currentWeek;

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
  /**
   * The caller's own registers, when they are a LEARNER placed in a group.
   *
   * A facilitator's own attendance is not a thing (they run the room), and an
   * admin reading over the cohort's shoulder has no row of their own either,
   * so both resolve to no reads at all rather than to an empty list built out
   * of documents nobody needed.
   *
   * ADDRESSED, never queried: the ids are `attendanceDocId`, which is
   * construct-only by contract, and there is no way to spell another group's
   * register from here. Bounded by the group's own taught sessions and capped
   * again below, so a corrupt plan cannot turn one page load into a hundred
   * reads.
   */
  /*
   * THEIR OWN PLACEMENT, never merely `ownGroup`. `ownGroup` falls back to the
   * single group the caller FACILITATES, so a learner whose own group has been
   * archived (it is filtered out above) would otherwise have their attendance
   * read out of the registers of a room they teach rather than sit in: real
   * marks, belonging to somebody, under the wrong group's dates. The id has to
   * match the enrolment for these registers to be theirs.
   */
  const ownLearnerGroup =
    liveEnrolment?.role === "learner" &&
    liveEnrolment.groupId &&
    ownGroup?.id === liveEnrolment.groupId
      ? ownGroup
      : null;
  // From the week they JOINED, then capped: a mid-run joiner has no row for
  // the weeks before their placement, and the read is bounded from that week
  // too rather than spending the cap on sessions about to be dropped.
  const ownSessions = ownLearnerGroup
    ? sessionsFromJoinWeek(
        resolveSessions(run, ownLearnerGroup, own.calendar),
        liveEnrolment?.joinedWeekNumber ?? 1,
      ).slice(0, MAX_OWN_ATTENDANCE_SESSIONS)
    : [];

  const [userDocs, weekEntries, ownRegisterDocs] = await Promise.all([
    facilitatorUids.length
      ? db.getAll(...facilitatorUids.map((uid) => db.collection("users").doc(uid)))
      : Promise.resolve([]),
    resolveWeekDocs(db, runId, ownGroup?.id ?? null),
    ownLearnerGroup && ownSessions.length
      ? db.getAll(
          ...ownSessions.map((s) =>
            db
              .collection("courseAttendance")
              .doc(
                attendanceDocId(
                  runId,
                  ownLearnerGroup.id,
                  s.weekNumber,
                  s.occurrence,
                ),
              ),
          ),
        )
      : Promise.resolve([]),
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

  /**
   * ONE CARD, ON ITS OWN GROUP'S CLOCK.
   *
   * The week key for the slot fields is THIS group's current week, not the
   * caller's. That is the bug this PR closes: the key used to be resolved once
   * from the caller's `currentWeek`, so a facilitator holding a group paced
   * three weeks behind the run saw the run's week's session override rendered
   * over that group's card: the wrong room, on the wrong date, with no way to
   * tell from the page.
   *
   * The modes deliberately do NOT collapse to this key: see `sessionModes` on
   * the wire type. A surface that draws another week reads that map and gets
   * the room-vs-link swap for the week it is actually showing.
   */
  const toCard = (source: CourseGroupDoc): OverviewGroup => {
    const groupCalendar = calendarFor(source);
    const session = sessionForWeek(source, currentWeekId(groupCalendar.currentWeek));
    // The group's own sessions, resolved off the calendar just resolved rather
    // than off a second one: `resolveSessions` would otherwise re-derive it,
    // and a second derivation is a second chance to disagree.
    const range = sessionRange(
      resolveSessions(run, source, groupCalendar.calendar),
      now,
    );
    return {
      id: source.id,
      name: source.name,
      calendar: {
        source: groupCalendar.calendar.source,
        startDate: groupCalendar.calendar.startDate,
        totalWeeks: groupCalendar.totalWeeks,
        currentWeek: groupCalendar.currentWeek,
        firstSessionDate: range.firstDateKey,
        lastSessionDate: range.lastDateKey,
        nextSession: range.next
          ? {
              weekNumber: range.next.weekNumber,
              occurrence: range.next.occurrence,
              sessionKey: range.next.sessionKey,
              dateKey: range.next.dateKey,
              startTimeLocal: range.next.session.startTimeLocal,
              durationMinutes: range.next.session.durationMinutes,
            }
          : null,
      },
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
  // had a card before is the same object they had before. NULL for a
  // multi-group facilitator, because `ownGroup` is. See the wire type.
  const group: OverviewGroup | null =
    (ownGroup ? groupCardPayloads.find((c) => c.id === ownGroup.id) : null) ?? null;

  /**
   * THE PROJECTION, keyed by session key rather than by array position.
   * `getAll` does answer in request order, but a register landing under the
   * wrong session would be a silent, plausible-looking lie about which evening
   * somebody missed, and `attendanceDocId` makes the id-to-session map free.
   *
   * `ownAttendanceSessions` reads four fields out of each register and copies
   * nothing: the whole room's marks and the facilitator's private participant
   * notes never enter this payload, and cannot start to when a field is added.
   */
  const ownRegisters = new Map<string, Record<string, unknown>>();
  if (ownLearnerGroup) {
    const sessionByDocId = new Map(
      ownSessions.map((s) => [
        attendanceDocId(runId, ownLearnerGroup.id, s.weekNumber, s.occurrence),
        s.sessionKey,
      ]),
    );
    for (const snap of ownRegisterDocs) {
      const key = sessionByDocId.get(snap.id);
      if (!snap.exists || !key) continue;
      ownRegisters.set(key, snap.data() ?? {});
    }
  }

  const rollup = liveEnrolment?.attendance ?? null;
  const ownAttendance: OverviewPayload["ownAttendance"] =
    ownLearnerGroup && rollup
      ? {
          sessions: ownAttendanceSessions(actor.uid, ownSessions, ownRegisters),
          rollup: {
            sessionsHeld: rollup.sessionsHeld,
            attendedInFull: rollup.attendedInFull,
            late: rollup.late,
            leftEarly: rollup.leftEarly,
            absent: rollup.absent,
            excused: rollup.excused,
            lastPushedSessionKey: rollup.lastPushedSessionKey,
            lastComputedAt: rollup.lastComputedAt
              ? rollup.lastComputedAt.toISOString()
              : null,
          },
        }
      : null;

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
      totalWeeks: own.totalWeeks,
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
    ownAttendance,
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
