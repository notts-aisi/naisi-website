import RunEditor from "@/features/courses/RunEditor";

/**
 * Admin run editor. The `(app)/admin` layout already gates on
 * `role === "admin"` server-side, so this page only has to resolve params and
 * hand off to the client editor (which reads Firestore directly — rules are
 * the real boundary for every write it makes).
 */
export default async function AdminCourseRunPage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string }>;
}) {
  const { courseId, runId } = await params;
  return <RunEditor courseId={courseId} runId={runId} />;
}
