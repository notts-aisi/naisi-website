import { requireAdminPage } from "@/lib/firebase/pageGates";

/**
 * The full-admin half of the admin area.
 *
 * `(admin-only)` is a route group, so it contributes nothing to the URLs: the
 * pages inside still live at `/admin`, `/admin/members`, `/admin/danger-zone`
 * and so on. What it buys is one place to say "a full admin, nobody else",
 * now that the parent `/admin` layout also admits course drafters and
 * approvers on their way to `/admin/courses`.
 *
 * Anything that is not part of the course authoring tree belongs in here. A
 * new admin page dropped straight into `src/app/(app)/admin/` would be gated
 * only by the widened parent, which is why `tests/no-admin-gating.test.mjs`
 * fails on exactly that mistake.
 */
export default async function AdminOnlyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPage();
  return <>{children}</>;
}
