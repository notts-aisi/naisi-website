import Link from "next/link";
import AdmissionsQueue from "@/features/courses/AdmissionsQueue";

/**
 * The admin mount of the admissions queue. A thin wrapper on purpose: the
 * `(app)/admin` layout already gates on `role === "admin"` server-side, so this
 * page owes nothing but the breadcrumb and the same component the reviewers'
 * `/learn/[runId]/admissions` page renders.
 *
 * One component, two mounts, and the ONLY difference between what an admin and
 * a reviewer see is `isAdmin` plus what the route chose to put in the payload
 * (applicant email addresses go to admins only). Forking this into an
 * admin-flavoured queue would put that rule in two places, and the second copy
 * is where it would eventually be got wrong.
 */

export default async function AdminRunApplicationsPage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string }>;
}) {
  const { courseId, runId } = await params;
  const runHref = `/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <Link
        href={runHref}
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-text-muted)",
          textDecoration: "none",
        }}
      >
        ← Back to the run editor
      </Link>

      <AdmissionsQueue runId={runId} isAdmin />
    </div>
  );
}
