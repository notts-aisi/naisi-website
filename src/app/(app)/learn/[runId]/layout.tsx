import { redirect } from "next/navigation";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";

/**
 * The gate on one run's learning space. Everything under `/learn/[runId]`
 * passes through here, so a new route in this tree inherits "you hold SOME
 * role on this run" for free and only has to narrow.
 *
 * WHAT THIS LAYOUT DOES NOT DO — pass data down. Next.js layouts render their
 * children as an opaque `children` prop; there is no props channel to a page.
 * That is why `getRunAccess` is `cache()`-wrapped: the page calls it again and
 * gets the same object back with no second Firestore read. Do not try to
 * thread the access object through context either — the pages below are a mix
 * of server and client components, and a provider would push the whole subtree
 * client-side to solve a problem the request cache already solves.
 *
 * WHO PASSES: anyone with any role on the run — enrolled member, facilitator,
 * admissions reviewer, track lead, admin. Reviewers and track leads pass ON
 * PURPOSE: `/admissions` is theirs. They get NO cohort surface, and every page
 * that is a cohort surface narrows to `canLearn` itself (a gate that admitted
 * a reviewer to the run home would be the only thing standing between the
 * admissions lane and the cohort).
 *
 * Redirects, never 403s: a member who guesses a run id learns nothing about
 * whether that run exists.
 */

export const dynamic = "force-dynamic";

export default async function RunLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  const access = await getRunAccess(runId);
  if (!access) {
    // Null is "no session" OR "no such run" — deliberately fused in
    // `getRunAccess` so run ids stay unenumerable. Only the destination
    // differs, and the session read is already memoised, so telling the two
    // apart here is free. `next` matches the proxy's convention so signing in
    // lands them where they were headed.
    const user = await getSessionUser();
    redirect(
      user ? "/learn" : `/login?next=${encodeURIComponent(`/learn/${runId}`)}`,
    );
  }

  const hasRunRole =
    access.canLearn || access.isReviewer || access.isTrackLead;
  if (!hasRunRole) redirect("/learn");

  return <>{children}</>;
}
