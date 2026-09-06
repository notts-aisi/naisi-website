import AdminCourseList from "@/features/courses/AdminCourseList";

/**
 * Admin course catalogue. `courses/layout.tsx` gates this whole tree with
 * `requireCourseAuthorPage()` (admin, `draftCourse` or `approveCourse`), so
 * this is a thin server wrapper around the client list: the reads are
 * client-side Firestore (one-shot + manual refresh), same as the other admin
 * tabs, and Firestore rules are the boundary on each one.
 */
export default function CoursesAdminPage() {
  return <AdminCourseList />;
}
