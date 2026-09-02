import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import { canApproveCourse, canDraftCourse } from "@/lib/firestore/users";
import AdminPageLockBar from "@/features/admin/AdminLockUI";
import AdminTabs from "./AdminTabs";

/**
 * The front door to the admin area.
 *
 * This gate used to be `role === "admin"` and nothing else, which made the
 * `draftCourse` and `approveCourse` grants unreachable: a member could be
 * given them and still be bounced off `/admin/courses`. It now admits course
 * permission holders too, so the real per-page enforcement moved down a level:
 * everything outside the course tree sits in the `(admin-only)` route group
 * behind `requireAdminPage()`, and `/admin/courses` repeats its own predicate
 * in `courses/layout.tsx`.
 *
 * The heading and the tab strip follow the caller: a course drafter gets
 * "Course admin" and a single tab, not the full committee console with twelve
 * sections they would only be redirected out of.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/dashboard");

  const isAdmin = user.role === "admin";
  const isCourseAuthor = canDraftCourse(user) || canApproveCourse(user);
  if (!isAdmin && !isCourseAuthor) redirect("/dashboard");

  return (
    <div>
      <div style={{ marginBottom: "var(--space-8)" }}>
        <div
          style={{
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "var(--space-2)",
          }}
        >
          Admin
        </div>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>
          {isAdmin ? "Committee controls" : "Course admin"}
        </h1>
      </div>
      <AdminTabs isAdmin={isAdmin} />
      <div style={{ marginTop: "var(--space-8)" }}>{children}</div>
      {/* Per-page, one-admin-at-a-time presence lease (keyed on the current admin
          route). Fail-open: renders nothing unless another admin holds the page. */}
      <AdminPageLockBar />
    </div>
  );
}
