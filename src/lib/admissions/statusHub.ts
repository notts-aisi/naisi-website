import {
  serialiseApplicationForOwner,
  serialiseRoundForApplicant,
  serialiseStageForApplicant,
} from "./applyRoutes";
import type { ApplicantApplication, ApplicantStage } from "./applyTypes";
import type {
  ApplicationStatusRow,
  NextStageSummary,
  StatusLinkKind,
} from "./statusTypes";
import type { AdmissionApplicationDoc } from "@/lib/firestore/admissionApplications";
import type {
  AdmissionRoundDoc,
  AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";

/**
 * The applicant STATUS HUB projection: one application row, joined to its
 * round, as the person who wrote it may see it.
 *
 * ## Why this is a projection and not a page reading documents
 *
 * `admissionApplications` and `admissionRounds` are both
 * `allow read, write: if false`, so every applicant-facing surface is already
 * server-side. That makes it easy to write a page that reads the documents
 * and renders "just the safe bits", and easy for the next page to pick a
 * slightly different set of safe bits. The row carries a facilitator's private
 * notes and a rejection reason the decider may deliberately not have shared,
 * so "slightly different" is the whole risk.
 *
 * So there is ONE function that turns documents into what an applicant sees,
 * it is built from the apply tree's existing projections rather than from a
 * spread of the document, and both the hub pages and
 * `GET /api/admissions/applications/me` call it. Adding a field to
 * `AdmissionApplicationDoc` cannot leak it here: it would have to be added to
 * `serialiseApplicationForOwner`, which is the function whose whole comment is
 * about what may not go in it.
 *
 * ## Pure, and no Admin SDK in the graph
 *
 * The reads live in `statusHubData.ts`. Keeping this half pure is what lets
 * `tests/admissions-status-hub.test.mjs` EXECUTE the projection (no email, no
 * evidence, no unshared reason on the wire) rather than read it and hope.
 */

/**
 * One stored answer as a sentence, for the read-back of a submitted form.
 *
 * Re-exported rather than defined here so every existing call site is
 * unchanged. It moved to a leaf because the appointment queue needs it and
 * that queue is reached from a client component, while this module imports the
 * apply tree's serialisers and so carries `server-only` behind it. See
 * `answerText.ts`.
 */
export { answerText } from "./answerText";

/**
 * The statuses that still have a form in front of them. A decided or
 * withdrawn application has no "next stage": telling somebody who was turned
 * down that part three opens on Monday would be worse than saying nothing.
 */
const LIVE_STATUSES = new Set<ApplicantApplication["status"]>(["draft", "submitted"]);

/**
 * The first stage this applicant has not frozen, released or not.
 *
 * ORDER COMES FROM THE STAGE, not from the array: `stageIds` is the asked
 * order and every stage carries its `order`, so a page that received them in
 * whatever order Firestore returned still names the right one.
 */
export function nextStageFor(
  stages: ApplicantStage[],
  application: ApplicantApplication,
): NextStageSummary | null {
  if (!LIVE_STATUSES.has(application.status)) return null;
  const ordered = [...stages].sort((a, b) => a.order - b.order);
  for (const stage of ordered) {
    if (application.stageSubmittedAt[stage.id]) continue;
    return {
      id: stage.id,
      label: stage.label,
      order: stage.order,
      released: stage.released,
      releasesAt: stage.released ? null : stage.releasesAt,
    };
  }
  return null;
}

/**
 * The one row.
 *
 * `now` is passed in rather than read here so a page rendering several rows
 * dates them all from the same instant: two rows deciding independently
 * whether the deadline has passed is how a hub shows "closed" beside "closes
 * in a moment" for the same clock tick.
 */
export function buildStatusRow(
  application: AdmissionApplicationDoc,
  round: AdmissionRoundDoc,
  stages: AdmissionStageDoc[],
  now: Date,
): ApplicationStatusRow {
  const serialisedRound = serialiseRoundForApplicant(round, now);
  // "" is not a shortcut: the access-requirements answer is deliberately never
  // joined on this surface. See `statusTypes.ts`.
  const serialisedApplication = serialiseApplicationForOwner(application, round, "");
  const serialisedStages = [...stages]
    .sort((a, b) => a.order - b.order)
    .map((stage) => serialiseStageForApplicant(stage, round, now));

  // "resume" IS A PROMISE THAT THE FORM STILL TAKES WRITES, so it asks the
  // window and not just the status. A draft the deadline overtook is still a
  // draft, and offering "carry on writing it" directly under "this was never
  // sent to us" would be the site contradicting itself in two consecutive
  // lines. `/apply/[roundId]` renders that draft read-only ("This one was
  // never sent", every answer still there), so the link stays and only its
  // meaning changes.
  const isDraft = application.status === "draft";
  const hrefKind: StatusLinkKind =
    isDraft && serialisedRound.windowState === "open" ? "resume" : "view";
  // `inactive` is a draft or archived round, which `/apply/[roundId]` answers
  // 404 for. A link there would be a dead end, so the row has none and says
  // so in its own words instead.
  const href =
    serialisedRound.windowState === "inactive"
      ? null
      : `/apply/${encodeURIComponent(round.id)}`;

  return {
    round: serialisedRound,
    application: serialisedApplication,
    stages: serialisedStages,
    nextStage: nextStageFor(serialisedStages, serialisedApplication),
    // THE SHARE GATE, and it is one line for a reason: the decider ticking
    // "share this" is the only thing that lets `outcome.reason` off the
    // document, and an applicant must never be handed the reason they were
    // turned down when the person who wrote it chose not to send it.
    sharedDecisionReason: application.outcome.reasonShared
      ? application.outcome.reason
      : "",
    href,
    hrefKind,
  };
}

/**
 * Most recently touched first, with a total order.
 *
 * `updatedAt` is the sort key because it is the one instant every row has
 * (a draft nobody has submitted, a submission, a withdrawal and a decision all
 * stamp it), and the tie-break is the round label so two rows written in the
 * same millisecond, or two rows with no timestamp at all, still come back in
 * the same order on every render. An unstable order on a list of applications
 * reads as the site losing one.
 */
export function sortStatusRows(rows: ApplicationStatusRow[]): ApplicationStatusRow[] {
  return [...rows].sort((a, b) => {
    const at = Date.parse(a.application.updatedAt ?? "") || 0;
    const bt = Date.parse(b.application.updatedAt ?? "") || 0;
    if (at !== bt) return bt - at;
    return a.round.label.localeCompare(b.round.label);
  });
}
