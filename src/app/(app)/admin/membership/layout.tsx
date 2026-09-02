import { requireMembershipPage } from "@/lib/firebase/pageGates";

/**
 * The membership console's own gate.
 *
 * Its own tree rather than the `(admin-only)` group, because the audience is
 * admins plus `manageMembership` holders: keeping the society's membership
 * record is a job somebody can hold without also holding approvals, the member
 * roster and the danger zone. Repeated below the front door on purpose, since
 * a gate that only exists one level up is a gate that quietly disappears the
 * next time somebody widens that level.
 *
 * Both membership collections are `allow read, write: if false`, so this gate
 * decides what renders and never what can be reached.
 */
export default async function MembershipAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireMembershipPage();
  return <>{children}</>;
}
