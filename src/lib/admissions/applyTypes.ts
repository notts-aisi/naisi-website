import type { AvailabilityGrid, AvailabilityMask } from "./availability";
import type { SerialisedStage } from "./roundRoutes";
import type {
  AdmissionApplicationDoc,
  ApplicationProgrammePreference,
} from "@/lib/firestore/admissionApplications";
import type { AdmissionRoundDoc } from "@/lib/firestore/admissionRounds";
import type { RsvpAnswer } from "@/lib/firestore/events";

/**
 * The WIRE SHAPES of the apply tree, in a module with no `server-only` import,
 * so the client can name them without pulling a server module into the bundle.
 *
 * The values that build these live in `applyRoutes.ts` (server) and the fetch
 * helpers that consume them live in `features/admissions/applyClient.ts`
 * (client). Both sides referring to the same declarations is what stops the
 * two drifting: adding a field to the projection without adding it here does
 * not compile.
 *
 * Dates cross as ISO strings and are re-hydrated exactly once, in the client
 * module, so no component ever holds a date that is secretly a string.
 */

/**
 * Everything an applicant may know about a round.
 *
 * Deliberately ABSENT, each for its own reason: `applicationCounts` (a live
 * scoreboard of a competitive intake), `reviewerUids` and `finalDeciderUid`
 * (the people deciding their application, by name), `criteria` and
 * `scoreScale` (what they are scored against), `blind`, `evidenceRunIds`,
 * `reminderOffsets`, `authorUid`, `clonedFromRoundId`.
 */
export type ApplicantRound = {
  id: string;
  kind: AdmissionRoundDoc["kind"];
  label: string;
  slug: string;
  blurb: string;
  academicYear: string;
  status: AdmissionRoundDoc["status"];
  windowState: "inactive" | "not-yet" | "open" | "closed";
  opensAt: string | null;
  closesAt: string | null;
  decisionsByDate: string | null;
  stageIds: string[];
  programmePreference: AdmissionRoundDoc["programmePreference"];
  availabilityGrid: AvailabilityGrid;
  accessRequirementsPrompt: string;
};

/**
 * A stage as an applicant sees it. The two arms are genuinely different
 * objects: an unreleased stage carries the four facts needed to render "Stage
 * 2 opens Mon 6 Nov, 09:00" and NOTHING more. It has no `questions` key, no
 * `questionCount` (which would leak how long the unseen stage is), and no
 * `intro` (which is authored prose about the questions).
 */
export type ApplicantStage =
  | ({ released: true } & SerialisedStage)
  | {
      released: false;
      id: string;
      order: number;
      label: string;
      /** ISO instant, or null when the stage rides the round's own opening. */
      releasesAt: string | null;
    };

/**
 * The OWNER projection of an application.
 *
 * `admissionApplications` is `allow read: if false` precisely because the row
 * carries `evidence.facilitatorNotes` (a facilitator's private assessment) and
 * `outcome.reason` / `outcome.reasonShared` (a decision the decider may have
 * chosen not to explain). Neither appears here, and neither may be added: the
 * moment this projection grows an `outcome` key, the read rule's whole reason
 * for existing is undone by a route instead of by a rule.
 *
 * `accessRequirements` lives in `admissionApplicationPrivate` and is joined in
 * only for the owner, who wrote it.
 */
export type ApplicantApplication = {
  id: string;
  roundId: string;
  status: AdmissionApplicationDoc["status"];
  stageAnswers: Record<string, Record<string, RsvpAnswer>>;
  stageSubmittedAt: Record<string, string | null>;
  availability: AvailabilityMask;
  availabilityConfigVersion: number;
  programmePreference: ApplicationProgrammePreference;
  accessRequirements: string;
  submittedAt: string | null;
  withdrawnAt: string | null;
  reapplyCount: number;
  updatedAt: string | null;
};

/** What every apply route answers with once it has done its work. */
export type ApplyContextPayload = {
  round: ApplicantRound;
  stages: ApplicantStage[];
  application: ApplicantApplication | null;
};
