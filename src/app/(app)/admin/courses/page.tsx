import AdminCourseList from "@/features/courses/AdminCourseList";

/**
 * Admin course catalogue. The `(app)/admin` layout already gates on
 * `role === "admin"`, so this is a thin server wrapper around the client list —
 * the reads are client-side Firestore (one-shot + manual refresh), same as the
 * other admin tabs.
 */
export default function CoursesAdminPage() {
  return <AdminCourseList />;
}
