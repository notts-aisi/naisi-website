import type {
  ApplicantApplication,
  ApplicantRound,
  ApplicantStage,
} from "./applyTypes";

/**
 * The WIRE SHAPES of the applicant status hub (`/applications`,
 * `/applications/[roundId]`, and `GET /api/admissions/applications/me`), in a
 * module with no `server-only` import so a client component can name them
 * without pulling a server module into the bundle. Same split, same reason, as
 * `applyTypes.ts`.
 *
 * The hub answers one question: "where has my application got to". Everything
 * it shows is built from the two projections the apply tree already has
 * (`serialiseApplicationForOwner` and `serialiseRoundForApplicant`) plus the
 * small number of JOINED facts below. Nothing here reaches around either of
 * them, which is what stops the hub becoming a second, laxer view of a
 * collection that is `allow read, write: if false`.
 */

/**
 * The next part of the form this applicant has to deal with, or null when
 * there is nothing left to do (every stage frozen, or the application is no
 * longer live).
 *
 * `released: false` is the interesting arm: it carries the label and the
 * instant and NOTHING about the questions, because an unreleased stage's
 * questions do not exist as far as any applicant surface is concerned (see
 * `stageRelease.ts`). The hub renders it as "Part 2 opens Mon 6 Oct, 09:00".
 */
export type NextStageSummary = {
  id: string;
  label: string;
  /** Position in the round's asked order, 0-based, as stored on the stage. */
  order: number;
  released: boolean;
  /** ISO instant, or null when the stage rides the round's own opening. */
  releasesAt: string | null;
};

/** Where the row's action link goes, and what it means. */
export type StatusLinkKind = "resume" | "view";

/**
 * One row of the hub: the caller's application to one round, joined to the
 * round it belongs to.
 *
 * DELIBERATELY ABSENT, and none of these may be added later without moving the
 * field off `admissionApplications` first:
 *
 *  - `email`. The row stores a server-sourced address for the team to write
 *    to. Echoing it back tells an attacker who has borrowed a session which
 *    address the account is reachable at, and the applicant already knows it.
 *  - `evidence`. `evidence.facilitatorNotes` is a facilitator's private
 *    written assessment of this person. It is the single sharpest reason
 *    `admissionApplications` is `allow read: if false`.
 *  - `outcome`, whole. The decider's `reason` is shown ONLY through
 *    `sharedDecisionReason` below, and only when they ticked `reasonShared`.
 *    Spreading `outcome` would undo that tick with a route rather than with a
 *    rule, which is exactly the failure the collection's read rule exists to
 *    prevent.
 *  - `membershipAtApply`, `seatApplicationId`, `reviewerPreferredGroupId`:
 *    staff bookkeeping about the applicant, not facts for them.
 *
 * `accessRequirements` is joined as `""` on this surface, always. It lives in
 * `admissionApplicationPrivate` because it will in practice carry disability
 * and health information, and the promise made in the privacy notice is that
 * reads of it are logged. The hub logs nothing, so it reads nothing: the apply
 * page is where an applicant sees their own answer back.
 */
export type ApplicationStatusRow = {
  /** The applicant projection of the round, window state resolved at `now`. */
  round: ApplicantRound;
  /** The owner projection of their own row, `accessRequirements` blank. */
  application: ApplicantApplication;
  /**
   * The round's stages as this applicant may see them: released ones carry
   * their questions (so the detail page can label the answers), unreleased
   * ones carry a date and nothing else.
   */
  stages: ApplicantStage[];
  nextStage: NextStageSummary | null;
  /**
   * The decider's reason, and ONLY when `outcome.reasonShared` is true.
   * Empty string in every other case, including a written-but-unshared one.
   */
  sharedDecisionReason: string;
  /**
   * Where this row's action goes: `/apply/[roundId]` either way, because that
   * page is both the form and the read-back of a submitted application.
   * Null when the round is no longer a public object at all (draft or
   * archived), where the apply page answers 404 and a link would be a dead
   * end rather than an affordance.
   */
  href: string | null;
  /** "resume" while the row is a draft the window still accepts. Else "view". */
  hrefKind: StatusLinkKind;
};

/** What `GET /api/admissions/applications/me` answers with. */
export type ApplicationStatusPayload = {
  rows: ApplicationStatusRow[];
};
