import { notFound, redirect } from "next/navigation";
import AppointmentsQueue from "@/features/admissions/AppointmentsQueue";
import { appointmentDecideBlock } from "@/lib/admissions/appointmentQueue";
import {
  canDecideAppointments,
  canViewAppointmentQueue,
  loadAppointmentQueue,
  loadAppointmentRound,
} from "@/lib/admissions/appointmentQueueData";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAdmissionsPage } from "@/lib/firebase/pageGates";

/**
 * The appointment queue for one round: every submitted facilitator
 * application, its answers, when the person can be in a room, and two buttons.
 *
 * ## Server-rendered on the Admin SDK, because there is no other way
 *
 * `admissionApplications` and `admissionRounds` are both
 * `allow read, write: if false`, so nothing on this page could be a client
 * listener even if it wanted to be. Every field the browser receives has been
 * chosen by `buildAppointmentQueueRow`, which is a field-by-field projection
 * rather than a spread: a facilitator's private notes about an applicant and
 * an unshared rejection reason both live on the document and neither reaches
 * this page.
 *
 * ## Three gates, and they answer different questions
 *
 *  1. `requireAdmissionsPage` (the tree's layout and this page): may you be in
 *     the admissions console at all?
 *  2. `round.kind === "appointment"`: is this a round that HAS appointments?
 *     An enrolment round answers 404 here rather than rendering an empty
 *     queue, because there is no such surface for one yet.
 *  3. `canViewAppointmentQueue` / `canDecideAppointments`: the round's own
 *     people. A reviewer reads; the final decider and admins decide. The
 *     difference is said in words on the page, not only expressed by hiding
 *     the buttons, so a reviewer knows why they cannot press one.
 *
 * The route enforces the third gate again regardless of what renders here.
 *
 * ALL THREE ARE ASKED BEFORE THE QUEUE IS READ, and the split between
 * `loadAppointmentRound` and `loadAppointmentQueue` is what makes that
 * possible. The queue read joins every applicant's user document, which is
 * member PII; reading it and then deciding the reader may not have it is the
 * wrong order to do those two things in.
 *
 * A fourth question is asked but is NOT a gate: `appointmentDecideBlock` says
 * whether the round is in a state that can be decided at all. A cancelled,
 * draft or archived round still READS here, because a decided round that was
 * later cancelled is exactly the thing somebody comes to this page to look up.
 * The buttons go, the sentence stays.
 */
export default async function AppointmentsPage({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const [{ roundId }, user] = await Promise.all([params, requireAdmissionsPage()]);

  const db = getAdminDb();
  if (!db) notFound();

  const round = await loadAppointmentRound(db, roundId);
  if (!round) notFound();
  if (round.kind !== "appointment") notFound();

  // Not a 403 page: somebody who followed a link to a round they are not on
  // has nothing to do here, and the console's own front page is where they can
  // always go. Same posture as `requireAdmissionsPage` itself.
  if (!canViewAppointmentQueue(user, round)) redirect("/admin/admissions");

  const bundle = await loadAppointmentQueue(db, round);

  return (
    <AppointmentsQueue
      roundId={roundId}
      roundLabel={round.label}
      rows={bundle.rows}
      runs={bundle.runs}
      outcomeRunIds={round.outcomeRunIds}
      rowsTruncated={bundle.rowsTruncated}
      runsTruncated={bundle.runsTruncated}
      canDecide={canDecideAppointments(user, round)}
      decideBlock={appointmentDecideBlock(round)}
    />
  );
}
