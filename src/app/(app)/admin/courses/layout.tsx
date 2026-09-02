import { requireCourseAuthorPage } from "@/lib/firebase/pageGates";

/**
 * The course authoring tree, open to admins and to anyone holding
 * `draftCourse` or `approveCourse`.
 *
 * The parent `/admin` layout already applies this same predicate, so on paper
 * this layout is redundant. It is here deliberately: the parent gate is the
 * one that has already been widened once, and a subtree whose only protection
 * is a level above it is a subtree that loses its protection silently the next
 * time somebody widens that level again.
 */
export default async function AdminCoursesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireCourseAuthorPage();
  return <>{children}</>;
}
