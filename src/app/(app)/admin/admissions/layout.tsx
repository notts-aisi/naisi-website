import { requireAdmissionsPage } from "@/lib/firebase/pageGates";

/**
 * The admissions console's own gate.
 *
 * Its own tree rather than the `(admin-only)` group, for the same reason
 * `/admin/courses` has one: the audience is not "full admins". A member
 * holding `approveCourse` authors rounds, and anyone appointed a reviewer on a
 * round can reach this page to see the round they are on. `requireAdmissionsPage`
 * is that predicate, repeated below the front door on purpose, because a gate
 * that only exists one level up is a gate that quietly disappears the next time
 * somebody widens that level.
 *
 * Writing is gated again at every route, and the round document itself is
 * `allow read, write: if false`, so this gate decides what renders and never
 * what can be reached.
 */
export default async function AdmissionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmissionsPage();
  return <>{children}</>;
}
