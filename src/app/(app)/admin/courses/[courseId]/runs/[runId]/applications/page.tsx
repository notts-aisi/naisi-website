import Link from "next/link";
import { requireCourseAuthorPage } from "@/lib/firebase/pageGates";
import AdmissionsQueue from "@/features/courses/AdmissionsQueue";

/**
 * The admin mount of the admissions queue. A thin wrapper on purpose:
 * `courses/layout.tsx` gates the tree server-side with
 * `requireCourseAuthorPage()` (admin, `draftCourse` or `approveCourse`), so
 * this page owes nothing but the breadcrumb and the same component the
 * reviewers' `/learn/[runId]/admissions` page renders.
 *
 * That gate is WIDER than the applications route's, which answers to admins,
 * the run's `admissionsReviewerUids` and its `trackLeadUids`. A course drafter
 * who holds no role on this run can open the URL and will see the queue's own
 * error, so RunEditor hides the link for exactly those callers.
 *
 * One component, two mounts, and the ONLY difference between what an admin and
 * a reviewer see is `isAdmin` plus what the route chose to put in the payload
 * (applicant email addresses go to admins only). Forking this into an
 * admin-flavoured queue would put that rule in two places, and the second copy
 * is where it would eventually be got wrong. `isAdmin` therefore comes from the
 * caller's real role, never from which URL they arrived on.
 */

export default async function AdminRunApplicationsPage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string }>;
}) {
  // The tree's gate, called again here for its RETURN VALUE: `isAdmin` decides
  // whether the queue shows applicant email addresses, and hard-coding it true
  // on an admin-shaped URL would hand that list to any course drafter who is
  // also a reviewer on the run. The route strips the addresses either way (it
  // is the only path to them), so this keeps the two sides agreeing rather than
  // rendering columns the payload will not fill.
  const user = await requireCourseAuthorPage();
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

      <AdmissionsQueue runId={runId} isAdmin={user.role === "admin"} />
    </div>
  );
}
