import CourseEditor from "@/features/courses/CourseEditor";

/**
 * Per-course editor. Route params are Promises in Next 16, so this stays an
 * async Server Component that awaits them and hands the id to the client
 * editor — the same wrapper shape as `/admin/email-designs/[templateId]`.
 * Access is already gated by the admin layout.
 */
export default async function AdminCourseEditorPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  return <CourseEditor courseId={courseId} />;
}
