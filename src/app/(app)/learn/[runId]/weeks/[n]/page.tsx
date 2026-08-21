import { redirect } from "next/navigation";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import WeekView from "@/features/courses/WeekView";

/**
 * Server shell for the member week page. All the page itself does is decide
 * whether this viewer belongs in the learning space and hand a validated week
 * number to the client `WeekView` (data on this page is client-fetched — the
 * check-off listener needs the client SDK anyway).
 *
 * Access via `getRunAccess` (React cache(), so the layout and sibling pages
 * share the reads): learners, facilitators and admins may learn; reviewers
 * and track leads are bounced to the admissions queue — their one course
 * surface, per the locked decision that admissions is a separate lane from
 * the cohort — and everyone else to the hub. Plain redirects, not 403s: a
 * member guessing run ids learns nothing about which runs exist.
 */

export const dynamic = "force-dynamic";

/** Matches the rules' weekNumber bound and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

export default async function WeekPage({
  params,
}: {
  params: Promise<{ runId: string; n: string }>;
}) {
  const { runId, n } = await params;

  const access = await getRunAccess(runId);
  if (!access) {
    // Null is "no session" OR "no such run" — getSessionUser (memoised, so
    // this is free) tells them apart without leaking which runs exist.
    const user = await getSessionUser();
    redirect(user ? "/learn" : "/login");
  }
  if (!access.canLearn) {
    redirect(
      access.isReviewer || access.isTrackLead
        ? `/learn/${encodeURIComponent(runId)}/admissions`
        : "/learn",
    );
  }

  // A positive int inside the plan's bounds; anything else (including "03" —
  // one canonical URL per week) goes back to the run home rather than 404ing.
  const weekNumber = /^[1-9]\d?$/.test(n) ? Number(n) : NaN;
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > MAX_WEEK_NUMBER) {
    redirect(`/learn/${encodeURIComponent(runId)}`);
  }

  const viewerRole = access.isAdmin
    ? "admin"
    : access.isFacilitator
      ? "facilitator"
      : "learner";

  return (
    <WeekView
      runId={runId}
      weekNumber={weekNumber}
      uid={access.user.uid}
      viewerRole={viewerRole}
    />
  );
}
