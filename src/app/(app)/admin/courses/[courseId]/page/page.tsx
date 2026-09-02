import CoursePageEditor from "@/features/courses/CoursePageEditor";

/**
 * `/admin/courses/[courseId]/page`: the editor for the course's PUBLIC
 * programme page (`coursePages/{courseId}`).
 *
 * Route params are Promises in Next 16, so this stays an async Server
 * Component that awaits them and hands the id to the client editor, the same
 * wrapper shape as the course editor beside it.
 *
 * Access is gated by `admin/courses/layout.tsx` (`requireCourseAuthorPage()`:
 * admin, `draftCourse` or `approveCourse`), which is what
 * `tests/no-admin-gating.test.mjs` insists on for anything under `/admin`.
 * The WRITE gate is narrower still and lives in the route:
 * `canAuthorCoursePage()` also requires a stated relationship to this
 * particular course, so a permission holder who wanders in here can open the
 * form and cannot save it.
 */
export default async function AdminCoursePagePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  return <CoursePageEditor courseId={courseId} />;
}
