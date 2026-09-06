import Link from "next/link";
import { redirect } from "next/navigation";
import ReviewQueue from "@/features/courses/ReviewQueue";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import { memberCurrentWeek, resolveCalendar } from "@/lib/courses/groupResolve";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";

/**
 * Server shell for the facilitator review queue: one group, one week's
 * exercises, everyone in it.
 *
 * ── THE GATE IS TWO CHECKS, NOT ONE ─────────────────────────────────────────
 * `[runId]/layout.tsx` has already established that the caller holds SOME role
 * on this run. That is nowhere near enough here: a learner, an admissions
 * reviewer and a facilitator of a DIFFERENT group all pass that bar, and none
 * of them may read this group's work. So this page re-reads the group document
 * and requires the caller's uid to be on `facilitatorUids` — group membership
 * cannot be inferred from the run, and the whole point of small groups is that
 * they are small.
 *
 * The group must also belong to THIS run. Group ids are top-level, so without
 * that check a facilitator could splice their own group id into another run's
 * URL; the check costs nothing and closes the shape.
 *
 * Admins bypass both, including the archived-group filter — an archived cohort
 * is exactly the thing an admin is asked to go back and look at.
 *
 * ── ARCHIVING A GROUP UNSTAFFS IT ───────────────────────────────────────────
 * ONE RULE, and the exercises route behind this page states the same one (see
 * its gate): a non-admin reads a group they facilitate only while it is LIVE.
 * Not the kinder "past work stays readable" lane, deliberately — `runAccess.ts`
 * already withholds facilitator status for an archived group, so someone whose
 * only group is archived never reaches this layout at all, and the run overview
 * has already dropped the card that links here. A page-level exception could
 * not deliver that kindness; it would only make this gate and the route
 * disagree about the same people, which is the state this replaced.
 *
 * Redirects, never 403s: someone guessing group ids learns nothing about which
 * ones exist. And this gate is a UI gate — the exercises and review ROUTES
 * re-derive the same access from the same documents, and are the actual
 * boundary.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const dynamic = "force-dynamic";

export default async function GroupReviewPage({
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

  // Live group only for a non-admin — the same predicate the exercises route
  // gates on (see the archiving note above).
  const facilitatesThisGroup =
    !group.archived && group.facilitatorUids.includes(access.user.uid);
  if (group.runId !== runId || !(access.isAdmin || facilitatesThisGroup)) {
    redirect(runHome);
  }

  // THIS GROUP's taught weeks, in ITS plan order — the group's own calendar
  // where it has re-paced itself, the run's otherwise (V2-3, through the one
  // resolver). A group that has cut a week out of its schedule must not be
  // offered it in the picker: there is nothing to review there, because its
  // members were never asked. Breaks carry no week doc at all, so they are not
  // reviewable and never appear either.
  const calendar = resolveCalendar(access.run, group);
  const weeks = calendar.weekPlan.flatMap((entry) =>
    entry.kind === "week" ? [entry.weekNumber] : [],
  );

  /**
   * Open on THE GROUP's week — the one a facilitator is almost always here
   * about, and for a re-paced group that is emphatically not the run's. During
   * a break that is the anchor (the last taught week), which is exactly where
   * the outstanding work lives.
   *
   * `memberCurrentWeek` inherits `currentWeekFor`'s `RangeError` contract on a
   * calendar with no usable start date, which is a legitimate half-authored
   * state rather than an error: fall back to the first authored week. The try
   * wraps ONLY that call — `redirect()` signals by throwing, so it must never
   * sit inside a catch.
   */
  let initialWeek = weeks[0] ?? 1;
  try {
    const current = memberCurrentWeek(access.run, group);
    const target =
      current.weekNumber ??
      (current.anchorWeekNumber > 0 ? current.anchorWeekNumber : null);
    if (target !== null && weeks.includes(target)) initialWeek = target;
  } catch {
    // Unusable start date — the first authored week stands.
  }

  const eyebrow = [access.run.courseTitle, access.run.label].filter(Boolean).join(" · ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div>
        {eyebrow && (
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--color-text-muted)",
            }}
          >
            {eyebrow}
          </p>
        )}
        <h1 style={{ margin: "var(--space-2) 0 0" }}>
          Review exercises — {group.name || "Group"}
        </h1>
        <p
          style={{
            margin: "var(--space-2) 0 0",
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
          }}
        >
          Everyone in this group, week by week. Feedback you send here is shown to
          the member on their own week page.{" "}
          <Link href={runHome} style={{ color: "var(--color-accent)" }}>
            Back to the course
          </Link>
        </p>
      </div>

      <ReviewQueue
        runId={runId}
        groupId={groupId}
        weeks={weeks}
        initialWeek={initialWeek}
      />
    </div>
  );
}
