import "server-only";
import {
  AVAILABILITY_DAYS,
  emptyMask,
  normalizeAvailabilityMask,
  type AvailabilityGrid,
  type AvailabilityMask,
} from "./availability";
import { isStageReleased, stageReleaseInstant } from "./stageRelease";
import { roundWindowState } from "./window";
import { serialiseStage } from "./roundRoutes";
import type {
  ApplicantApplication,
  ApplicantRound,
  ApplicantStage,
} from "./applyTypes";
import { validateAnswers } from "@/lib/events/validateAnswers";
import {
  ADMISSION_APPLICATION_FIELD_LIMITS,
  EMPTY_APPLICATION_PROGRAMME_PREFERENCE,
  type AdmissionApplicationDoc,
  type ApplicationProgrammePreference,
} from "@/lib/firestore/admissionApplications";
import { ADMISSION_PRIVATE_FIELD_LIMITS } from "@/lib/firestore/admissionApplicationPrivate";
import type {
  AdmissionRoundDoc,
  AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";
import type { RsvpAnswer } from "@/lib/firestore/events";

/** Re-exported so route files import one module rather than two. */
export type { ApplicantApplication, ApplicantRound, ApplicantStage };

/**
 * Shared plumbing for the APPLICANT half of the rounds tree: what a round
 * looks like to somebody applying to it, which stages they may see the
 * questions of, and how their answers are read back off the wire.
 *
 * ## Why this is a separate module from `roundRoutes.ts`
 *
 * `roundRoutes.ts` serves STAFF. Its `canSeeRound` admits authors, course
 * drafters, reviewers and the final decider, and its `serialiseRound` sends
 * the whole document, counters and `finalDeciderUid` included. None of that
 * may reach an applicant. Two audiences sharing one serialiser is how the
 * reviewer list ends up in a fresher's devtools: the shape is a spread, the
 * spread is invisible at the call site, and nothing fails.
 *
 * So the applicant projection is built FIELD BY FIELD below, and adding a
 * field to `AdmissionRoundDoc` does not silently add it to the applicant's
 * payload. `serialiseStage` is reused verbatim, because there the decision
 * that matters (may this caller see the questions) is already an explicit
 * argument.
 *
 * ## The release filter runs BEFORE serialisation, always
 *
 * `serialiseStageForApplicant` asks `isStageReleased` and RETURNS on the
 * unreleased branch. It does not build a serialised stage and then delete a
 * key: a stage that is not released is a different, smaller object which has
 * never had a `questions` key on it at any point in its construction. That is
 * the whole timed-release guarantee (see `stageRelease.ts`), and
 * `tests/admissions-apply-flow.test.mjs` pins the ordering against the source
 * of this function so a refactor cannot invert it.
 */

// ---------------------------------------------------------------------------
// Rate limits and reCAPTCHA
// ---------------------------------------------------------------------------

/**
 * Abuse throttles for the apply tree. Generous per IP because a university
 * society shares campus NAT (`rateLimit.ts` states the reasoning); tighter per
 * account, where a real person has no reason to be near the limit.
 *
 * The AUTOSAVE limit is its own axis: the form saves every two minutes while
 * dirty, so ten minutes of continuous typing is five legitimate PATCHes before
 * a single explicit Save is pressed. A shared create/save budget would spend
 * an applicant's create allowance on their own typing.
 */
export const APPLY_RATE_LIMITS = {
  windowMs: 10 * 60 * 1000,
  createIpMax: 40,
  createUidMax: 6,
  saveIpMax: 300,
  saveUidMax: 40,
} as const;

/**
 * Which actions mint a reCAPTCHA token, and which deliberately do not.
 *
 * VERIFIED: create, submit, and each later stage submit. Every one of those is
 * a deliberate press of a button by a person who is looking at the screen, so
 * a challenge (for the small share of users Google flags) lands at a moment
 * they can answer it.
 *
 * NOT VERIFIED: the draft save. It fires on a 120-second timer while the tab
 * may be backgrounded, and a Google token expires after about two minutes, so
 * a token minted at page load would be stale by the first autosave and a token
 * minted per autosave could pop an image challenge over a half-written essay
 * with nobody watching. The draft save is protected by its own rate limit
 * instead, and it can only ever write to a row the caller already owns: it
 * creates nothing, so there is no cost for a bot to inflate.
 */
export const RECAPTCHA_ACTIONS = ["create", "submit", "stage-submit"] as const;
export type RecaptchaAction = (typeof RECAPTCHA_ACTIONS)[number];

// ---------------------------------------------------------------------------
// The applicant's view of a round
// ---------------------------------------------------------------------------

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function serialiseRoundForApplicant(
  round: AdmissionRoundDoc,
  now: Date,
): ApplicantRound {
  return {
    id: round.id,
    kind: round.kind,
    label: round.label,
    slug: round.slug,
    blurb: round.blurb,
    academicYear: round.academicYear,
    status: round.status,
    windowState: roundWindowState(round, now).state,
    opensAt: iso(round.opensAt),
    closesAt: iso(round.closesAt),
    decisionsByDate: round.decisionsByDate,
    stageIds: round.stageIds,
    programmePreference: round.programmePreference,
    availabilityGrid: round.availabilityGrid,
    accessRequirementsPrompt: round.accessRequirementsPrompt,
  };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export function serialiseStageForApplicant(
  stage: AdmissionStageDoc,
  round: AdmissionRoundDoc,
  now: Date,
): ApplicantStage {
  // THE FILTER, and it comes first. The unreleased arm returns here, so no
  // code path below it has ever held a serialised copy of the questions.
  if (!isStageReleased(stage, round, now)) {
    return {
      released: false,
      id: stage.id,
      order: stage.order,
      label: stage.label,
      releasesAt: iso(stageReleaseInstant(stage)),
    };
  }
  return { released: true, ...serialiseStage(stage, true) };
}

/** The released stages, in asked order. What every validation path iterates. */
export function releasedStages(
  stages: AdmissionStageDoc[],
  round: AdmissionRoundDoc,
  now: Date,
): AdmissionStageDoc[] {
  return stages.filter((stage) => isStageReleased(stage, round, now));
}

// ---------------------------------------------------------------------------
// The applicant's view of their own row
// ---------------------------------------------------------------------------

/**
 * The applicant's own row, projected for them.
 *
 * ## Stages the round no longer has are pruned on the way out
 *
 * A round can delete a stage (`DELETE .../stages/[stageId]` takes it off
 * `round.stageIds`), and a draft written before that still carries the
 * deleted stage's answers under its old key. Sending those keys back would
 * wedge the form: the apply island seeds its answer state from this payload
 * and sends the whole map on every save, so an orphan key would ride out on
 * every PATCH forever. Pruning here means the client is never handed a key it
 * cannot use, and `readStageAnswers` drops the same keys on the way in for the
 * client that already has one in state.
 *
 * Nothing is lost by it: the stored answers stay on the row, and the questions
 * they answered are gone from the round either way.
 */
export function serialiseApplicationForOwner(
  application: AdmissionApplicationDoc,
  round: AdmissionRoundDoc,
  accessRequirements: string,
): ApplicantApplication {
  const onRound = new Set(round.stageIds);
  const stageSubmittedAt: Record<string, string | null> = {};
  for (const [stageId, at] of Object.entries(application.stageSubmittedAt)) {
    if (!onRound.has(stageId)) continue;
    stageSubmittedAt[stageId] = iso(at);
  }
  const stageAnswers: Record<string, Record<string, RsvpAnswer>> = {};
  for (const [stageId, answers] of Object.entries(application.stageAnswers)) {
    if (!onRound.has(stageId)) continue;
    stageAnswers[stageId] = answers;
  }
  return {
    id: application.id,
    roundId: application.roundId,
    status: application.status,
    stageAnswers,
    stageSubmittedAt,
    availability: application.availability,
    availabilityConfigVersion: application.availabilityConfigVersion,
    programmePreference: application.programmePreference,
    accessRequirements,
    submittedAt: iso(application.submittedAt),
    withdrawnAt: iso(application.withdrawnAt),
    reapplyCount: application.reapplyCount,
    updatedAt: iso(application.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Reading the applicant's payload
// ---------------------------------------------------------------------------

export type FieldError = {
  error: string;
  /** The question the message belongs against, when there is one. */
  questionId?: string;
  /** The stage the question is on, so a multi-stage form can open the right one. */
  stageId?: string;
};

function isFieldError(v: unknown): v is FieldError {
  return Boolean(v && typeof v === "object" && "error" in (v as object));
}

/**
 * Validate the answers a client sent for the stages it names.
 *
 * REFUSES rather than ignores a stage that is on the round but not released,
 * or one already frozen. A silent drop is the failure mode that costs an
 * applicant their essay: they type into a stage the server has decided to
 * discard, watch "Saved" appear, and find the box empty tomorrow. Both
 * refusals name the stage.
 *
 * A stage id that is NOT ON THE ROUND AT ALL is the one case that is dropped
 * instead, and the reason is that refusing it makes the draft permanently
 * unsaveable. When a round deletes a stage, a draft written before the
 * deletion still holds answers under the old key; the apply island seeds its
 * state from the row and sends the whole map on every save, so a refusal would
 * come back on every autosave and every press of Save with nothing the
 * applicant could do about it. There is nothing to lose by dropping it either:
 * the key names no stage, so there is no question it could be an answer to and
 * no writer that could ever store it. `serialiseApplicationForOwner` prunes
 * the same keys on the way out, so a fresh load never carries one.
 *
 * `enforceRequired` is the draft/submit split: a draft is half written by
 * definition, so a blank required question is fine on the way in and refused
 * on the way out. Everything else (unknown options, over-limit answers,
 * malformed shapes) stays enforced on a draft, so a draft can never hold a
 * value the submit path would then have to reject.
 */
export function readStageAnswers(
  raw: unknown,
  stages: AdmissionStageDoc[],
  round: AdmissionRoundDoc,
  now: Date,
  frozen: Record<string, Date | null>,
  enforceRequired: boolean,
): Record<string, Record<string, RsvpAnswer>> | FieldError {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Your answers arrived in a shape this site cannot read." };
  }
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const out: Record<string, Record<string, RsvpAnswer>> = {};
  for (const [stageId, answers] of Object.entries(raw as Record<string, unknown>)) {
    const stage = byId.get(stageId);
    // Dropped, not refused: see the note above. An unknown id is unwritable,
    // and refusing it would wedge the whole save forever.
    if (!stage) continue;
    if (!isStageReleased(stage, round, now)) {
      return { error: `"${stage.label}" has not been released yet.`, stageId };
    }
    if (frozen[stageId]) {
      return { error: `"${stage.label}" is already submitted, so it cannot be changed.`, stageId };
    }
    const validated = validateAnswers(stage.questions, answers, { enforceRequired });
    if ("error" in validated) {
      return { error: validated.error, questionId: validated.questionId, stageId };
    }
    out[stageId] = validated.answers;
  }
  return out;
}

/**
 * Read a drawn availability grid off the wire.
 *
 * The GEOMETRY is the round's and only ever the round's: the client sends
 * `days` (seven hex strings) and the server spreads the round's own grid
 * around them. A payload claiming its own `startMinute` would otherwise let an
 * applicant store an answer whose bit 0 means 06:00 while every reader
 * decoding it against the round believes it means 09:00, and the allocation
 * board would put them in a session they never offered.
 */
export function readAvailability(
  raw: unknown,
  grid: AvailabilityGrid,
): AvailabilityMask | FieldError {
  if (raw === undefined || raw === null) return emptyMask(grid);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Your availability arrived in a shape this site cannot read." };
  }
  const days = (raw as Record<string, unknown>).days;
  if (days !== undefined && !Array.isArray(days)) {
    return { error: "Your availability arrived in a shape this site cannot read." };
  }
  if (Array.isArray(days) && days.length > AVAILABILITY_DAYS) {
    return { error: "That is more days than the grid has." };
  }
  // The round's grid FIRST, so `days` cannot bring a geometry with it. A
  // malformed column decodes to an empty one rather than to whatever its
  // prefix happened to say (see `availability.ts`).
  return normalizeAvailabilityMask({ ...grid, days }, grid);
}

/**
 * Read the programme-preference answer against what the round actually
 * offers. A ranking of a fellowship the round does not run is a stored
 * preference nobody can honour, and the decide route would have to guess.
 *
 * An APPOINTMENT round drops the answer whole, on the kind rather than on the
 * section's `enabled` flag. The facilitator form shows no programme section, so
 * a payload carrying one is either a stale tab or a hand-made request, and in
 * both cases storing it would leave the decide route reading a preference
 * nobody was asked for. The authoring PATCH refuses to enable the section on
 * this kind; this is the same rule enforced on the way in, so the two cannot
 * come apart.
 */
export function readProgrammePreference(
  raw: unknown,
  round: AdmissionRoundDoc,
): ApplicationProgrammePreference | FieldError {
  const section = round.programmePreference;
  if (round.kind === "appointment" || !section.enabled) {
    return { ...EMPTY_APPLICATION_PROGRAMME_PREFERENCE };
  }
  if (raw === undefined || raw === null) {
    return { ...EMPTY_APPLICATION_PROGRAMME_PREFERENCE };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Your programme choice arrived in a shape this site cannot read." };
  }
  const body = raw as Record<string, unknown>;

  let streamId: string | null = null;
  if (typeof body.streamId === "string" && body.streamId) {
    if (!section.streams.some((option) => option.id === body.streamId)) {
      return { error: "That is not one of the streams this round offers." };
    }
    streamId = body.streamId;
  }

  const rankedRaw = body.rankedFellowshipIds;
  if (rankedRaw !== undefined && rankedRaw !== null && !Array.isArray(rankedRaw)) {
    return { error: "Your fellowship ranking arrived in a shape this site cannot read." };
  }
  const ranked: string[] = [];
  for (const entry of Array.isArray(rankedRaw) ? rankedRaw : []) {
    if (typeof entry !== "string" || !entry) continue;
    if (!section.fellowships.some((option) => option.id === entry)) {
      return { error: "That is not one of the fellowships this round offers." };
    }
    if (!ranked.includes(entry)) ranked.push(entry);
  }
  const cap = Math.min(
    section.maxRankedFellowships,
    ADMISSION_APPLICATION_FIELD_LIMITS.maxRankedFellowships,
  );
  if (ranked.length > cap) {
    return {
      error: `You can rank at most ${cap} fellowship${cap === 1 ? "" : "s"}.`,
    };
  }

  return {
    streamId,
    rankedFellowshipIds: ranked,
    // The question is only asked when the round asks it, so an answer to an
    // unasked question is dropped rather than stored as a preference the
    // decide route would read as consent to a fellowship offer.
    openToFellowship: section.offerFellowshipFallback && body.openToFellowship === true,
  };
}

/** The access-requirements answer, which never lands on the application row. */
export function readAccessRequirements(raw: unknown): string | FieldError {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    return { error: "Your access-requirements answer arrived in a shape this site cannot read." };
  }
  const value = raw.trim();
  const max = ADMISSION_PRIVATE_FIELD_LIMITS.accessRequirements;
  if (value.length > max) {
    return {
      error: `The access-requirements box is ${value.length - max} character${value.length - max === 1 ? "" : "s"} over its limit of ${max}.`,
    };
  }
  return value;
}

export { isFieldError };
