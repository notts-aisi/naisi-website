import RetrospectiveView from "@/features/courses/RetrospectiveView";

/**
 * The admin mount of one run's retrospective.
 *
 * Thin on purpose: `(app)/admin/layout.tsx` already gates on `role === "admin"`
 * server-side, and the view owns its own breadcrumb.
 *
 * STAFF WIDER THAN ADMIN: the retrospective ROUTES answer to admins, the
 * `draftCourse` / `approveCourse` permission holders and the run's track leads
 * — wider than this page, exactly as the allocation board's are. That is not an
 * oversight. A non-admin drafter cannot reach `/admin/**` at all, and minting
 * them a second admin-shaped URL would mean two places where the gate has to be
 * got right. Their mount, when it lands, is the learn-side one rendering this
 * same component against these same routes; the route gate is the boundary
 * either way, and this page is only the admin's door to it.
 */
export default async function AdminRunRetrospectivePage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string }>;
}) {
  const { courseId, runId } = await params;
  return <RetrospectiveView courseId={courseId} runId={runId} />;
}
