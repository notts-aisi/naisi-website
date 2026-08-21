import { redirect } from "next/navigation";
import RunHome from "@/features/courses/RunHome";
import { getRunAccess } from "@/features/courses/runAccess";

/**
 * The run home — the page a learner opens daily, and the stage for the
 * WeekRail's once-per-session draw.
 *
 * ROUTING IS THIS FILE'S WHOLE JOB. It resolves the caller's role on this run
 * and decides where they belong; everything visible lives in `RunHome`, a
 * client component, because the learning space's data moves under the reader
 * and the draw is a mount-time effect.
 *
 *   canLearn                    → the cohort view
 *   reviewer / track lead only  → /admissions, their entire surface on this
 *                                 run. Admissions is a separate lane from the
 *                                 cohort (locked decision, stated from the
 *                                 other side in the overview route): reviewing
 *                                 applications grants no sight of the people
 *                                 who were admitted.
 *   anyone else                 → /learn — a plain redirect rather than a 403,
 *                                 so a guessed run id reveals nothing about
 *                                 whether that run exists.
 *
 * The redirects are convenience, not the boundary: every route behind them
 * re-derives access from the session, so a member who reaches a surface they
 * shouldn't sees an error, not someone else's cohort.
 */

export const dynamic = "force-dynamic";

export default async function RunHomePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  // Free: `[runId]/layout.tsx` already called this, and `getRunAccess` is
  // `cache()`-wrapped, so the second call is the same object, not a second pair
  // of reads.
  const access = await getRunAccess(runId);
  // Null fuses "no session" with "no such run" on purpose (run ids stay
  // unenumerable). The layout has already split those two and redirected, so
  // reaching this line means a request raced a change; the hub is the right
  // landing for every branch of it.
  if (!access) redirect("/learn");

  if (!access.canLearn) {
    if (access.isReviewer || access.isTrackLead) {
      redirect(`/learn/${encodeURIComponent(runId)}/admissions`);
    }
    redirect("/learn");
  }

  // `isAdmin` travels as a prop rather than being read off the overview
  // payload: that payload's `access` block is a mirror of the server's
  // decision, and this one is the decision.
  return <RunHome runId={runId} isAdmin={access.isAdmin} />;
}
