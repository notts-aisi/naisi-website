import { redirect } from "next/navigation";
import { getRunAccess } from "@/features/courses/runAccess";
import ProgressBody from "./ProgressBody";

/**
 * One run's progress, week by week — a cohort surface, so it narrows the
 * `[runId]` layout to `canLearn`.
 *
 * The layout admits admissions reviewers and track leads (their route is
 * `/admissions`); neither may see the cohort. Sending them to the queue they
 * DO hold rather than back to the hub is the difference between a redirect
 * that reads as "wrong door" and one that reads as "you have no business
 * here" — both are the same non-disclosure, so the friendlier one wins.
 *
 * The header renders server-side from the run doc the gate already read, so
 * the page names itself on the first paint and only the numbers wait for data.
 */

export const dynamic = "force-dynamic";

export default async function RunProgressPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  const access = await getRunAccess(runId);
  // Re-checked rather than assumed: a page must never rely on its layout
  // having run. `getRunAccess` is `cache()`-wrapped, so this is free.
  if (!access) redirect("/learn");

  if (!access.canLearn) {
    redirect(
      access.isReviewer || access.isTrackLead
        ? `/learn/${encodeURIComponent(runId)}/admissions`
        : "/learn",
    );
  }

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
        <h1 style={{ margin: "var(--space-2) 0 0" }}>Progress</h1>
      </div>

      <ProgressBody runId={runId} />
    </div>
  );
}
