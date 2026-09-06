import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import AttendanceGrid from "@/features/courses/AttendanceGrid";
import GroupRoster from "@/features/courses/GroupRoster";
import SessionCard from "@/features/courses/SessionCard";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import { resolveGroupCalendar } from "@/lib/courses/groupResolve";
import { resolveSessions, sessionRange } from "@/lib/courses/sessions";
import { type CurrentWeek } from "@/lib/courses/weekPlan";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  normalizeCourseGroup,
  sessionForWeek,
  sessionModeForWeek,
  sessionModesOf,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import { weekDocId } from "@/lib/firestore/courses";
import type { OverviewGroup } from "@/app/api/courses/runs/[runId]/overview/route";

/**
 * Server shell for the facilitator's group page: who is in the group, when it
 * meets, and the attendance register.
 *
 * ── THE GATE IS TWO CHECKS, NOT ONE ─────────────────────────────────────────
 * `[runId]/layout.tsx` has already established that the caller holds SOME role
 * on this run. That is nowhere near enough here: a learner, an admissions
 * reviewer and a facilitator of a DIFFERENT group all pass that bar, and none
 * of them may mark this group's register. So this page re-reads the group
 * document and requires the caller's uid to be on `facilitatorUids` — group
 * membership cannot be inferred from the run, and the whole point of small
 * groups is that they are small.
 *
 * The group must also belong to THIS run. Group ids are top-level, so without
 * that check a facilitator could splice their own group id into another run's
 * URL; the check costs nothing and closes the shape.
 *
 * ── ARCHIVING A GROUP UNSTAFFS IT ───────────────────────────────────────────
 * ONE RULE, stated identically here, in the review page beside it, in the
 * routes behind both, and in `runAccess.ts`: a non-admin reads a group they
 * facilitate only while it is LIVE. Admins bypass it — an archived cohort is
 * exactly the thing an admin is asked to go back and look at.
 *
 * Redirects, never 403s: someone guessing group ids learns nothing about which
 * ones exist. And this is a UI gate — the roster, attendance and email ROUTES
 * re-derive the same access from the same documents and are the real boundary.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY THE SESSION IS RESOLVED HERE AND NOT FETCHED ────────────────────────
 * The roster route deliberately does NOT carry the meeting link (group docs
 * are read-locked to the authoring tier precisely because they hold it), and
 * the run overview only ever describes ONE group — the caller's own, which for
 * someone facilitating two groups is neither of the ones they are looking at.
 * So the session card is fed from the group document this gate has already
 * read, with the Admin SDK, after establishing that the reader is a
 * facilitator of this group or an admin: the two people the overview route
 * also lets see a meeting link.
 */

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Session label (duplicated on purpose — see below)
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
 * "Tuesdays 18:00–19:30" — byte-for-byte the label the overview route, the
 * apply page, the admissions queue and the allocation board render, so a slot
 * reads the same everywhere it appears. Deliberately duplicated (the plan's
 * integration checklist owns the eventual shared extraction). The format is
 * the contract; change all copies together.
 */
function sessionLabel(session: GroupSession): string {
  const day = WEEKDAY_NAMES[session.weekday];
  if (!day || !session.startTimeLocal) return "";
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  return `${day}s ${session.startTimeLocal}${end ? `–${end}` : ""}`;
}

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

/**
 * Inline, like the review page beside it: these shells own a heading, a
 * sentence and two links, and a stylesheet per route for that would be more
 * indirection than the thing it styles. Anything with real layout in it lives
 * in a component with its own module.
 */
const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-6)",
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--color-text-muted)",
};

const subStyle: CSSProperties = {
  margin: "var(--space-2) 0 0",
  maxWidth: "62ch",
  fontSize: "var(--text-sm)",
  lineHeight: 1.6,
  color: "var(--color-text-muted)",
};

const linkRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2)",
  marginTop: "var(--space-4)",
};

/** 44px-tall targets: these are the page's two real actions. */
const actionLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2.75rem",
  padding: "0 var(--space-4)",
  border: "1px solid var(--color-border-strong)",
  borderRadius: "var(--radius-md)",
  color: "var(--color-text)",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  textDecoration: "none",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function GroupHomePage({
  params,
}: {
  params: Promise<{ runId: string; groupId: string }>;
}) {
  const { runId, groupId } = await params;

  const access = await getRunAccess(runId);
  if (!access) {
    // Null is "no session" OR "no such run" — deliberately fused in
    // `getRunAccess`. `getSessionUser` is memoised by now, so telling the two
    // apart costs nothing and leaks nothing.
    const user = await getSessionUser();
    redirect(user ? "/learn" : "/login");
  }

  const runHome = `/learn/${encodeURIComponent(runId)}`;

  // Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
  // separator and `doc()` would throw — a 500 out of a gate whose whole job is
  // to redirect. Same guard `getRunAccess` applies to the run id.
  if (!groupId || groupId.includes("/") || groupId === "." || groupId === "..") {
    redirect(runHome);
  }

  const db = getAdminDb();
  if (!db) redirect(runHome);

  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  if (!groupSnap.exists) redirect(runHome);
  const group = normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {});

  // Live group only for a non-admin — the same predicate every route behind
  // this page gates on (see the archiving note above).
  const facilitatesThisGroup =
    !group.archived && group.facilitatorUids.includes(access.user.uid);
  if (group.runId !== runId || !(access.isAdmin || facilitatesThisGroup)) {
    redirect(runHome);
  }

  /**
   * THIS GROUP's whole calendar, for the session card underneath, not the
   * run's.
   *
   * `resolveGroupCalendar` is the group-first replacement for `currentWeekFor`
   * (V2-3): a group that has re-paced itself is on its own week, and a
   * facilitator's own page is the last place that should disagree with what
   * their members are looking at. It resolves to the run's calendar for the
   * overwhelmingly common group that has overridden nothing, and it answers
   * with a null week on a calendar with no usable start date rather than
   * throwing: a legitimate half-authored state, on which the card falls back
   * to the recurring label and stays stateless.
   *
   * It is the SAME helper the overview route builds every group card from, so
   * this page and the run home cannot drift apart about this group's dates.
   */
  // ONE CLOCK for both resolutions on this render. Two default clocks a
  // millisecond apart across a midnight would put the week counter and the
  // "next session" line in different cohort weeks, on one page.
  const now = new Date();
  const groupCalendar = resolveGroupCalendar(access.run, group, now);
  const currentWeek: CurrentWeek | null = groupCalendar.currentWeek;
  const range = sessionRange(
    resolveSessions(access.run, group, groupCalendar.calendar),
    now,
  );

  // A break week and the before/after phases have no week doc of their own, so
  // the session override falls back to the anchor (the last taught week that
  // started) — the slot the group will return to. Empty means "no override",
  // which `sessionForWeek` resolves to the recurring slot.
  const weekNumber = currentWeek
    ? (currentWeek.weekNumber ?? currentWeek.anchorWeekNumber)
    : 0;
  const weekId = weekNumber >= 1 ? weekDocId(weekNumber) : "";
  const session = sessionForWeek(group, weekId);

  const sessionGroup: OverviewGroup = {
    id: group.id,
    name: group.name,
    // THIS group's calendar, resolved through the same helper the overview
    // route uses, so a facilitator's own page and their run home agree about
    // which week this room is on and when its term runs.
    calendar: {
      source: groupCalendar.calendar.source,
      startDate: groupCalendar.calendar.startDate,
      totalWeeks: groupCalendar.totalWeeks,
      currentWeek,
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
    // The gate above is the check the overview route calls `canSeeMeetingUrl`:
    // a facilitator of this group, or an admin. Nobody else reaches this line.
    meetingUrl: session.meetingUrl,
    // The whole map, exactly as the overview route sends it — this shape IS
    // `OverviewGroup`, and a divergence here would mean the facilitator's own
    // card is fed differently from their members'. The card below is handed
    // the CURRENT week's entry out of it, which is the week the slot fields
    // above were resolved for.
    sessionModes: sessionModesOf(group),
    // Left empty on purpose rather than paid for with a second read: the
    // roster below names the facilitators, and repeating them on the card
    // above it would say the same thing twice.
    facilitatorNames: [],
  };

  const eyebrow = [access.run.courseTitle, access.run.label].filter(Boolean).join(" · ");
  const groupPath = `${runHome}/group/${encodeURIComponent(groupId)}`;

  return (
    <div style={pageStyle}>
      <div>
        {eyebrow && <p style={eyebrowStyle}>{eyebrow}</p>}
        <h1 style={{ margin: "var(--space-2) 0 0" }}>{group.name || "Group"}</h1>
        <p style={subStyle}>
          Everyone in the group, when it meets, and the register. Names only — no
          email addresses appear here.{" "}
          <Link href={runHome} style={{ color: "var(--color-accent)" }}>
            Back to the course
          </Link>
        </p>

        <div style={linkRowStyle}>
          <Link href={`${groupPath}/review`} style={actionLinkStyle}>
            Review exercises
          </Link>
          {/* The copy-on-write surface: this group's weeks, its schedule, and
              the notice that tells everyone when either changes. Same gate as
              this page, restated in its own shell. */}
          <Link href={`${groupPath}/edit`} style={actionLinkStyle}>
            Weeks &amp; schedule
          </Link>
          <Link href={`${groupPath}/email`} style={actionLinkStyle}>
            Email the group
          </Link>
        </div>
      </div>

      <SessionCard
        group={sessionGroup}
        slotStartKey={currentWeek?.slotStartKey ?? null}
        // The same week key the slot above was resolved for, so the
        // facilitator's card swaps exactly as their members' does — this page
        // is where they check that the flip they just made looks right.
        mode={sessionModeForWeek(group, weekId)}
      />

      <GroupRoster groupId={groupId} groupName={group.name} />

      {/* The register owns its own heading, its own week controls and its own
          horizontal overflow — a wide table handles its own responsiveness
          rather than widening the shell (the `.mainWide` rule). */}
      <AttendanceGrid groupId={groupId} runId={runId} />
    </div>
  );
}
