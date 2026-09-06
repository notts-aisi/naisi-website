import RoundEditor from "@/features/admissions/RoundEditor";
import { requireAdmissionsPage } from "@/lib/firebase/pageGates";

/**
 * One round's console.
 *
 * The gate runs again here rather than being inherited silently, and it hands
 * the editor `isAdmin`, which now decides two things rather than one:
 *
 *  - appointing reviewers is admin-only (membership of `reviewerUids` is what
 *    grants access to applications), and the member list the picker needs is
 *    readable only by admins and SU-recognised committee;
 *  - the danger zone at the foot of the page, where a round is destroyed.
 *    That removes other people's applications, the access-requirements answer
 *    filed beside each one and the reviewers' written assessments, so it sits
 *    above the `approveCourse` permission that lets somebody author a round.
 *
 * Both are rendering decisions. The roles route and the two destroy routes
 * enforce the same bar for themselves, whatever this page draws.
 */
export default async function RoundPage({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const [{ roundId }, user] = await Promise.all([params, requireAdmissionsPage()]);
  return <RoundEditor roundId={roundId} isAdmin={user.role === "admin"} />;
}
