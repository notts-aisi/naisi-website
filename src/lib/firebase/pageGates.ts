import "server-only";
import { redirect } from "next/navigation";
import {
  canApproveCourse,
  canAuthorAdmissionRound,
  canDraftCourse,
} from "@/lib/firestore/users";
import { getCurrentUser, type SessionUser } from "./session";

/**
 * Server-side page gates for the authed admin tree.
 *
 * Until this module existed, `(app)/admin/layout.tsx` was the ONLY gate on
 * every admin page: it redirected anyone whose role was not `admin`, and each
 * page underneath simply trusted that. That was safe exactly as long as the
 * layout stayed admin-only. It no longer is: course drafters and approvers now
 * need `/admin/courses`, so the layout gate has widened, and every page that
 * still needs a full admin has to say so itself.
 *
 * Both helpers redirect rather than render a refusal. A member who follows a
 * stale link to an admin page has nothing to act on there, and `/dashboard` is
 * the page they can always use.
 */

/**
 * Full admin only. Applied by the `(admin-only)` route group's layout, which
 * wraps every admin page outside the course authoring tree. Returns the
 * session so a caller that also needs the uid or display name does not have to
 * read it twice.
 */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/dashboard");
  return user;
}

/**
 * Admin, `draftCourse`, or `approveCourse`. The course authoring tree under
 * `/admin/courses` is the one part of the admin area a non-admin permission
 * holder may reach, and this is the same predicate `(app)/admin/layout.tsx`
 * uses to let them past the front door. Repeated on the subtree on purpose: a
 * gate that only exists one level up is a gate that quietly disappears the
 * next time somebody widens that level.
 */
export async function requireCourseAuthorPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user || !(user.role === "admin" || canDraftCourse(user) || canApproveCourse(user))) {
    redirect("/dashboard");
  }
  return user;
}

/**
 * The admissions console, `/admin/admissions`. Its own tree and its own gate,
 * for the same reason `/admin/courses` has one: the `(admin-only)` group would
 * be wrong in both directions here.
 *
 * Two audiences reach this tree, and they are not the same set:
 *
 *  - AUTHORS: an admin, or a member holding `approveCourse`
 *    (`canAuthorAdmissionRound`). They write the round.
 *  - REVIEWERS: anyone the roles route has appointed on some round, carried on
 *    `users.admissionsReviewer`. They write nothing here. They are admitted so
 *    the Admissions entry in the sidebar goes somewhere rather than bouncing
 *    them to `/dashboard`, which is the dead-link failure the denormalised
 *    flag exists to avoid. The round page renders them a read-only summary,
 *    and every route under `/api/admissions` re-checks the round's own
 *    `reviewerUids` regardless of what this gate let through.
 *
 * The gate is a page-level convenience, never the boundary: the boundary is
 * each route, and `admissionRounds` is `allow read, write: if false` so
 * nothing here can be reached client-direct.
 */
export async function requireAdmissionsPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user || !(canAuthorAdmissionRound(user) || user.admissionsReviewer === true)) {
    redirect("/dashboard");
  }
  return user;
}
