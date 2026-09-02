import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import { getImpersonator, markerIsLive } from "@/lib/firebase/impersonation";
import {
  canApproveCourse,
  canAuthorAdmissionRound,
  canDraftCourse,
} from "@/lib/firestore/users";
import AdminPageLockBar from "@/features/admin/AdminLockUI";
import AdminTabs, { type AdminTabAccess } from "./AdminTabs";

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
 *
 * CLOSED DURING A VIEW-AS SESSION. The course editors under `/admin/courses`
 * write to Firestore CLIENT-DIRECT (`courseMutations.ts` setDoc/updateDoc from
 * CourseEditor, RunEditor, WeekEditor and GroupEditor), so there is no route
 * handler in the path for `assertNotImpersonating()` to sit in, and view-as
 * would record every one of those writes as the member. Now that a member
 * holding `draftCourse` can reach this tree, an admin viewing as that member
 * would land on the authoring surfaces with nothing between them and a write
 * attributed to the wrong person. So the tree renders a notice instead of its
 * children while the marker is live.
 *
 * The notice rather than a redirect is deliberate: view-as exists to answer
 * "what does this member see", and bouncing to /dashboard would answer that
 * question wrongly by implying the member cannot reach the admin area at all.
 * The tab strip still renders for the same reason.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/dashboard");

  const isAdmin = user.role === "admin";
  const isCourseAuthor = canDraftCourse(user) || canApproveCourse(user);
  // Appointed reviewers reach `/admin/admissions` and nothing else. Without
  // this branch the Admissions entry in the sidebar, which is drawn off the
  // server-owned `users.admissionsReviewer` flag, would bounce exactly the
  // non-admin SU reviewers the flag exists to serve, which is the dead-link
  // failure the denormalisation was added to avoid.
  const isAdmissionsReviewer = user.admissionsReviewer === true;
  if (!isAdmin && !isCourseAuthor && !isAdmissionsReviewer) redirect("/dashboard");

  const access: AdminTabAccess = {
    isAdmin,
    canAuthorCourses: isCourseAuthor,
    canAuthorRounds: canAuthorAdmissionRound(user),
    isAdmissionsReviewer,
  };

  // A marker whose actorUid matches this session is stale, not a session (the
  // admin is signed in as themselves again); markerIsLive is the same
  // comparison the banner and the write guard use.
  const marker = await getImpersonator();
  const viewingAs = markerIsLive(marker, user.uid);

  if (viewingAs) {
    return (
      <div>
        <AdminHeading access={access} />
        <AdminTabs access={access} />
        <div
          style={{
            marginTop: "var(--space-8)",
            padding: "var(--space-6)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-lg)",
            background: "var(--color-surface)",
            maxWidth: "42rem",
          }}
        >
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>
            The admin area is closed while you are viewing as someone else
          </h2>
          <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-3)" }}>
            You are signed in as another member, so anything saved here would be
            written to Firestore in their name and would read as their work
            afterwards. The course editors save straight from the browser, so
            the whole tree is closed rather than each button.
          </p>
          <p style={{ color: "var(--color-text-muted)" }}>
            Exit the view-as session from the banner above and open this page as
            yourself.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AdminHeading access={access} />
      <AdminTabs access={access} />
      <div style={{ marginTop: "var(--space-8)" }}>{children}</div>
      {/* Per-page, one-admin-at-a-time presence lease (keyed on the current admin
          route). Fail-open: renders nothing unless another admin holds the page. */}
      <AdminPageLockBar />
    </div>
  );
}

/** Eyebrow + title. Shared by the open and the closed-during-view-as renders so
 *  the page identifies itself the same way in both. The title follows the
 *  caller: a course drafter and an appointed reviewer are both in here for one
 *  section, and "Committee controls" would be a promise neither can act on. */
function AdminHeading({ access }: { access: AdminTabAccess }) {
  return (
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
        {access.isAdmin
          ? "Committee controls"
          : access.canAuthorCourses
            ? "Course admin"
            : "Admissions"}
      </h1>
    </div>
  );
}
