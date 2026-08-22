import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import GroupPaceEditor from "@/features/courses/GroupPaceEditor";
import { GroupWeekIndex } from "@/features/courses/GroupWeekEditor";
import RoomNoticeComposer from "@/features/courses/RoomNoticeComposer";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import { memberCurrentWeek, resolveCalendar } from "@/lib/courses/groupResolve";
import type { CurrentWeek } from "@/lib/courses/weekPlan";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  normalizeCourseGroup,
  sessionForWeek,
  sessionModeForWeek,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import { weekDocId } from "@/lib/firestore/courses";

/**
 * Server shell for the facilitator's editing surface: the group's weeks, its
 * schedule, and the notice that tells the group when either changes.
 *
 * ── THE GATE IS THE GROUP PAGE'S GATE, SPELLED OUT AGAIN ────────────────────
 * `[runId]/layout.tsx` has established that the caller holds SOME role on this
 * run, which is nowhere near enough: a learner, an admissions reviewer and a
 * facilitator of a DIFFERENT group all clear that bar and none of them may
 * rewrite this group's curriculum. So this page re-reads the group document and
 * requires the caller on `facilitatorUids`, on a group that belongs to THIS run
 * and is not archived — archiving a group unstaffs it, the same one rule the
 * group page, the review page, the email page and `runAccess.ts` all state.
 *
 * Redirects, never 403s: someone guessing group ids learns nothing about which
 * ones exist. And this is a UI gate — the fork, patch, pace and notice ROUTES
 * re-derive the same access from the same documents and are the real boundary.
 *
 * ── WHY SO MUCH IS READ HERE AND HANDED DOWN ────────────────────────────────
 * `courseGroups` reads are restricted to the authoring tier in firestore.rules
 * (group docs carry the meeting link), and a plain facilitator is not in it. So
 * everything that lives on the group doc — the pace overrides, the session, its
 * per-week mode — is read here with the Admin SDK, after the gate, and passed
 * as props. The week CONTENT is different: both `courseRuns/{id}/weeks` and
 * `courseGroups/{id}/weeks` are signed-in readable, so the client fetches those
 * itself and this shell stays out of the N-week read.
 *
 * ── ONE CALENDAR, RESOLVED ONCE ─────────────────────────────────────────────
 * `resolveCalendar` decides whether this group is paced by its own overrides or
 * by the run, and everything below is handed the ANSWER rather than the two
 * inputs. That is the same helper the member's week page, rail, pacing banner
 * and nudge email use, which is what makes "the dates the facilitator edits
 * against" and "the dates the member is shown" the same dates by construction.
 */

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Session label (duplicated on purpose — see the group page's note)
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

/** "Tuesdays 18:00–19:30" — byte-for-byte the label every other course surface
 *  renders. The format is the contract; change all copies together. */
function sessionLabel(session: GroupSession): string {
  const day = WEEKDAY_NAMES[session.weekday];
  if (!day || !session.startTimeLocal) return "";
  const end = endTimeLabel(session.startTimeLocal, session.durationMinutes);
  return `${day}s ${session.startTimeLocal}${end ? `–${end}` : ""}`;
}

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

/** Inline, like the group and review pages beside it — see the group page. */
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

const linkStyle: CSSProperties = { color: "var(--color-accent)" };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function GroupEditIndexPage({
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
  // to redirect.
  if (!groupId || groupId.includes("/") || groupId === "." || groupId === "..") {
    redirect(runHome);
  }

  const db = getAdminDb();
  if (!db) redirect(runHome);

  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  if (!groupSnap.exists) redirect(runHome);
  const group = normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {});

  const facilitatesThisGroup =
    !group.archived && group.facilitatorUids.includes(access.user.uid);
  if (group.runId !== runId || !(access.isAdmin || facilitatesThisGroup)) {
    redirect(runHome);
  }

  // THE one place this page decides whose calendar is in force. `group`
  // satisfies `GroupPaceSource` structurally; null on either override means
  // "tracks the run", which is a different thing from an empty plan.
  const calendar = resolveCalendar(access.run, group);

  /**
   * Where the group is right now, for the "Now" marker and the notice prefill.
   *
   * `memberCurrentWeek` throws `RangeError` on a calendar with no usable start
   * date, which is a legitimate half-authored state rather than an error. The
   * try wraps ONLY that call — `redirect()` signals by throwing, so it must
   * never sit inside a catch.
   */
  let current: CurrentWeek | null = null;
  try {
    current = memberCurrentWeek(access.run, group);
  } catch {
    // Unusable start date — no "now" marker, and the notice has no prefill.
  }

  // The week the group is IN, for the notice. Only while the group is actually
  // inside its plan: "we're on Zoom this week" is a lie before the run starts.
  const slot =
    current && current.phase === "running" && current.planIndex !== null
      ? (calendar.weekPlan[current.planIndex] ?? null)
      : null;
  // `weekDocId(weekNumber)`, NOT the plan entry's own `weekId` — the one
  // addressing doctrine. The session override and the mode this composer
  // prefills from are written and read under that key by every other surface
  // (`sessionForWeek`'s own contract), so resolving the plan's spelling here
  // would prefill the notice from a DIFFERENT week's arrangement on a
  // reordered plan.
  const currentWeekId =
    slot && slot.kind === "week" ? weekDocId(slot.weekNumber) : "";
  const currentSession = sessionForWeek(group, currentWeekId);

  const noticeSession =
    slot === null
      ? null
      : {
          weekLabel:
            slot.kind === "week"
              ? `Week ${slot.weekNumber}`
              : slot.label || "This week",
          slotLabel: sessionLabel(currentSession),
          // Null when nothing is set for this week — the composer treats that
          // as "no change to announce" rather than inventing one.
          mode: sessionModeForWeek(group, currentWeekId),
          location: currentSession.location,
          meetingUrl: currentSession.meetingUrl,
        };

  const eyebrow = [access.run.courseTitle, access.run.label].filter(Boolean).join(" · ");
  const groupPath = `${runHome}/group/${encodeURIComponent(groupId)}`;
  const groupLabel = group.name || "your group";

  return (
    <div style={pageStyle}>
      <div>
        {eyebrow && <p style={eyebrowStyle}>{eyebrow}</p>}
        <h1 style={{ margin: "var(--space-2) 0 0" }}>Edit {groupLabel}</h1>
        <p style={subStyle}>
          What {groupLabel} reads each week, when it meets, and how to tell
          everyone when that changes. Your group follows the course until you
          change something — and only the things you change stop following it.{" "}
          <Link href={groupPath} style={linkStyle}>
            Back to the group
          </Link>
        </p>
      </div>

      <GroupWeekIndex
        runId={runId}
        groupId={groupId}
        groupName={groupLabel}
        weekPlan={calendar.weekPlan}
        startDate={calendar.startDate}
        calendarSource={calendar.source}
        nowIndex={current?.planIndex ?? null}
      />

      <GroupPaceEditor
        groupId={groupId}
        groupName={groupLabel}
        runStartDate={access.run.startDate}
        runWeekPlan={access.run.weekPlan}
        paceStartDate={group.paceStartDate}
        paceWeekPlan={group.paceWeekPlan}
      />

      <RoomNoticeComposer
        groupId={groupId}
        groupName={groupLabel}
        groupHref={groupPath}
        session={noticeSession}
      />
    </div>
  );
}
