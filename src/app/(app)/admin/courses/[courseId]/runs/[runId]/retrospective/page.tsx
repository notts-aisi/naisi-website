import RetrospectiveView from "@/features/courses/RetrospectiveView";

/**
 * The admin mount of one run's retrospective.
 *
 * Thin on purpose: `courses/layout.tsx` gates the tree server-side with
 * `requireCourseAuthorPage()` (admin, `draftCourse` or `approveCourse`), and
 * the view owns its own breadcrumb.
 *
 * TRACK LEADS: the retrospective ROUTES answer to admins, the `draftCourse` /
 * `approveCourse` holders and the run's track leads, so they overlap this
 * page's gate rather than nesting inside it: a track lead holding neither
 * permission cannot open this URL. That is not an oversight. The ROUTE is the
 * boundary, this page is one door to it, and the track lead's door is the
 * learn-side mount rendering this same component against these same routes
 * when it lands.
 */
export default async function AdminRunRetrospectivePage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string }>;
}) {
  const { courseId, runId } = await params;
  return <RetrospectiveView courseId={courseId} runId={runId} />;
}
