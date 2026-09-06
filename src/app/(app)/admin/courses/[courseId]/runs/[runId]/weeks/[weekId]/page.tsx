import WeekEditor from "@/features/courses/WeekEditor";

/**
 * Admin week editor. Weeks live at `courseRuns/{runId}/weeks/{wNN}` — under the
 * RUN, not the course — because a week's content is one cohort's delivery of
 * it, and copy-forward clones ids into the next run rather than sharing them.
 * The route mirrors that shape so the breadcrumb and the data model agree.
 *
 * `courses/layout.tsx` gates the tree server-side with
 * `requireCourseAuthorPage()` (admin, `draftCourse` or `approveCourse`), so
 * this page only resolves params and hands off to the client editor (which
 * reads and writes Firestore directly: rules are the real boundary).
 */
export default async function AdminCourseWeekPage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string; weekId: string }>;
}) {
  const { courseId, runId, weekId } = await params;
  return <WeekEditor courseId={courseId} runId={runId} weekId={weekId} />;
}
