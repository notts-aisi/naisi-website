import { redirect } from "next/navigation";
import GroupWeekEditor from "@/features/courses/GroupWeekEditor";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import { resolveCalendar } from "@/lib/courses/groupResolve";
import { addDaysToKey, isValidDateKey } from "@/lib/courses/weekPlan";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  normalizeCourseGroup,
  sessionForWeek,
  sessionModeForWeek,
} from "@/lib/firestore/courseGroups";
import { weekDocId } from "@/lib/firestore/courses";

/**
 * Server shell for one week of one group's curriculum.
 *
 * The gate is the edit index's gate, restated rather than shared for the same
 * reason every other page under `group/[groupId]` restates it: a facilitator of
 * THIS group while it is live, or an admin. Being on the run, reviewing its
 * applications, or facilitating a different group are all insufficient, and
 * archiving a group unstaffs it. Redirects, never 403s.
 *
 * ── THE WEEK MUST BE IN THIS GROUP'S SCHEDULE ───────────────────────────────
 * `weekId` is checked against the RESOLVED calendar — the group's own plan when
 * it has one, the run's otherwise — not against the run's plan. A group that
 * has taken a week out of its schedule is a group whose facilitator should not
 * be editing that week's content: it is not something their members will ever
 * see, and letting the URL through would produce a fork nobody reads. Anything
 * that is not a slot in the group's plan goes back to the index.
 *
 * The session, its per-week mode, and the group's pace overrides all live on
 * the group document, which `courseGroups` rules keep away from a plain
 * facilitator's client. They are read here, after the gate, and handed down.
 */

export const dynamic = "force-dynamic";

/** `weeks/{wNN}` — one canonical spelling, so "w3" and "W03" both bounce. */
const WEEK_ID = /^w\d{2}$/;

export default async function GroupWeekEditPage({
  params,
}: {
  params: Promise<{ runId: string; groupId: string; weekId: string }>;
}) {
  const { runId, groupId, weekId } = await params;

  const access = await getRunAccess(runId);
  if (!access) {
    const user = await getSessionUser();
    redirect(user ? "/learn" : "/login");
  }

  const runHome = `/learn/${encodeURIComponent(runId)}`;

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

  const editIndex = `${runHome}/group/${encodeURIComponent(groupId)}/edit`;
  if (!WEEK_ID.test(weekId)) redirect(editIndex);

  const calendar = resolveCalendar(access.run, group);

  // Matched by `weekDocId(weekNumber)`, NOT by the plan entry's own `weekId` —
  // the one addressing doctrine (see `useGroupWeeks`, which builds the links
  // that land here, and the doctrine GUARD in
  // `tests/course-schedule-changes.test.mjs`). On a reordered plan the two
  // spellings disagree, and this page must resolve the document the group's
  // members read for that slot.
  const planIndex = calendar.weekPlan.findIndex(
    (entry) => entry.kind === "week" && weekDocId(entry.weekNumber) === weekId,
  );
  if (planIndex === -1) redirect(editIndex);
  const slot = calendar.weekPlan[planIndex];
  // Narrowing for TypeScript: `findIndex` above already guaranteed this.
  if (slot.kind !== "week") redirect(editIndex);

  const from = isValidDateKey(calendar.startDate)
    ? addDaysToKey(calendar.startDate, planIndex * 7)
    : "";
  const to = from ? addDaysToKey(from, 6) : "";

  const session = sessionForWeek(group, weekId);

  return (
    <GroupWeekEditor
      runId={runId}
      courseId={access.run.courseId}
      groupId={groupId}
      groupName={group.name || "your group"}
      weekId={weekId}
      weekNumber={slot.weekNumber}
      from={from}
      to={to}
      // Null when the facilitator has never set a mode for this week — NOT the
      // same as "in person", and the editor's copy depends on the difference.
      mode={sessionModeForWeek(group, weekId)}
      location={session.location}
      meetingUrl={session.meetingUrl}
      viewerIsAdmin={access.isAdmin}
    />
  );
}
