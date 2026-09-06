import { redirect } from "next/navigation";
import AdmissionsQueue from "@/features/courses/AdmissionsQueue";
import { getRunAccess } from "@/features/courses/runAccess";

/**
 * A reviewer's whole course surface: the admissions queue for one run, and
 * nothing else.
 *
 * Admissions is a SEPARATE ROLE from facilitation (locked decision). Being on
 * a run's `admissionsReviewerUids` grants sight of its applications and no
 * sight of its cohort — there is deliberately no link from here into the
 * learning space, and no other `/learn/[runId]/*` route accepts a reviewer.
 *
 * The gate below is a NARROWING of `[runId]/layout.tsx`, which has already
 * established that the caller holds some role on this run. Narrowing is the
 * whole of it: the layout admits facilitators and enrolled members too, and
 * they have no business here. Deleting the `allowed` check would put a pile of
 * applications in front of every member of the cohort. `getRunAccess` is
 * `cache()`-wrapped, so re-asking costs nothing — the layout's reads are
 * already memoised for this request.
 *
 * Track leads may READ this queue but may not decide; that split lives in the
 * routes (the decide/notes handlers re-check), which is where it belongs —
 * a page gate that let the wrong person in would otherwise be the only
 * boundary.
 */

export const dynamic = "force-dynamic";

export default async function RunAdmissionsPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  const access = await getRunAccess(runId);
  // Null is no session or no such run; the layout has already sent both of
  // those somewhere. Re-checked rather than asserted because a page must never
  // rely on a layout having run — layouts and pages are separately routable
  // units and a future refactor could reorder them.
  if (!access) redirect("/learn");

  const allowed = access.isAdmin || access.isReviewer || access.isTrackLead;
  // A plain redirect, not a 403: a member who lands here by guessing a run id
  // learns nothing about whether that run exists.
  if (!allowed) redirect("/learn");

  const { run } = access;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--color-text-muted)",
          }}
        >
          {run.courseTitle || "Course"} — {run.label || "Untitled run"}
        </p>
        <h1 style={{ margin: "var(--space-2) 0 0" }}>Admissions</h1>
      </div>

      {/* `isAdmin` controls exactly one thing: whether applicant email
          addresses render. The route decides whether any were sent. */}
      <AdmissionsQueue runId={runId} isAdmin={access.isAdmin} />
    </div>
  );
}
