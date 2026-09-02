import RoundEditor from "@/features/admissions/RoundEditor";
import { requireAdmissionsPage } from "@/lib/firebase/pageGates";

/**
 * One round's console.
 *
 * The gate runs again here rather than being inherited silently, and it hands
 * the editor `isAdmin`: appointing reviewers is admin-only (membership of
 * `reviewerUids` is what grants access to applications), and the member list
 * the picker needs is readable only by admins and SU-recognised committee. The
 * roles route enforces both regardless of what renders.
 */
export default async function RoundPage({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const [{ roundId }, user] = await Promise.all([params, requireAdmissionsPage()]);
  return <RoundEditor roundId={roundId} isAdmin={user.role === "admin"} />;
}
