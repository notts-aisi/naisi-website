import "server-only";
import type { SessionUser } from "@/lib/firebase/session";
import { canAuthorAdmissionRound, canDraftCourse } from "@/lib/firestore/users";
import type {
  AdmissionRoundDoc,
  AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";

/**
 * Shared plumbing for the `/api/admissions/rounds` tree: who may see a round,
 * and what a round looks like on the wire.
 *
 * ## Why serialisation lives here rather than in each route
 *
 * `admissionRounds` and its `stages` subcollection are both
 * `allow read, write: if false`, so EVERY staff surface reads them through
 * these routes. That makes the JSON shape the de facto public interface of the
 * collection, and a shape assembled independently in four handlers is a shape
 * that will disagree with itself: one route sending `closesAt` as an ISO
 * string and another as a Firestore timestamp object is a bug the console
 * discovers as an "Invalid Date" three weeks later.
 *
 * Dates go out as ISO strings. The client re-hydrates them once, in the round
 * client module, so no component ever parses a date itself.
 *
 * ## The `questions` rule, restated where it is easy to break
 *
 * Stage questions are the timed-release guarantee. They may be serialised for
 * an AUTHOR (they are authoring them) and never for anyone else on this tree.
 * `serialiseStage` therefore takes the decision as a required argument rather
 * than defaulting: a caller that forgets has to write `false` on purpose.
 */

export const ROUNDS_COLLECTION = "admissionRounds";
export const STAGES_SUBCOLLECTION = "stages";

/** Everything the access decision needs, and nothing else. */
type RoundAccessInput = Pick<
  AdmissionRoundDoc,
  "reviewerUids" | "finalDeciderUid"
>;

/**
 * May this caller AUTHOR rounds: create one, edit one, move its status, write
 * its stages? Admin or `approveCourse`, checked against the live session.
 */
export function canAuthorRounds(user: SessionUser): boolean {
  return canAuthorAdmissionRound(user);
}

/**
 * May this caller SEE this round at all?
 *
 * Authors, `draftCourse` holders (they are staff on the course tree and the
 * round is the thing their run is fed by), and the people the round itself
 * names: its reviewers and its final decider. Nobody else, which is what makes
 * the list route safe to call from any authed session: it answers with the
 * rounds you are on, or with nothing.
 */
export function canSeeRound(user: SessionUser, round: RoundAccessInput): boolean {
  if (canAuthorRounds(user)) return true;
  if (canDraftCourse(user)) return true;
  if (round.reviewerUids.includes(user.uid)) return true;
  return round.finalDeciderUid === user.uid;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export type SerialisedRound = Omit<
  AdmissionRoundDoc,
  "opensAt" | "closesAt" | "createdAt" | "updatedAt"
> & {
  opensAt: string | null;
  closesAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export function serialiseRound(round: AdmissionRoundDoc): SerialisedRound {
  return {
    ...round,
    opensAt: iso(round.opensAt),
    closesAt: iso(round.closesAt),
    createdAt: iso(round.createdAt),
    updatedAt: iso(round.updatedAt),
  };
}

export type SerialisedStage = Omit<
  AdmissionStageDoc,
  "questions" | "manualReleasedAt" | "closesAt" | "createdAt" | "updatedAt"
> & {
  /** Present ONLY for an author. See the module comment. */
  questions?: AdmissionStageDoc["questions"];
  /** Always present, so a non-author surface can still show "6 questions". */
  questionCount: number;
  manualReleasedAt: string | null;
  closesAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export function serialiseStage(
  stage: AdmissionStageDoc,
  includeQuestions: boolean,
): SerialisedStage {
  const { questions, ...rest } = stage;
  return {
    ...rest,
    ...(includeQuestions ? { questions } : {}),
    questionCount: questions.length,
    manualReleasedAt: iso(stage.manualReleasedAt),
    closesAt: iso(stage.closesAt),
    createdAt: iso(stage.createdAt),
    updatedAt: iso(stage.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/** An ISO instant, `null`, or `undefined` for "the caller did not mention it". */
export type ParsedInstant =
  | { ok: true; value: Date | null }
  | { ok: false; error: string };

/**
 * Read an instant off a request body. The console sends ISO strings because
 * `opensAt` and `closesAt` are INSTANTS, derived in the browser from a London
 * date and time the admin typed. That derivation is safe there and only there:
 * the picker knows the zone offset for the date it is showing, and a bare
 * "18 Oct 23:59" crossing the wire would have to be re-derived by a server
 * with no idea which zone the admin meant.
 *
 * A malformed string is refused rather than coerced. `new Date("18/10/2026")`
 * is `Invalid Date` in Node and `NaN` on comparison, which would sail through
 * a truthiness check and store a deadline nobody can meet.
 */
export function parseInstant(raw: unknown, field: string): ParsedInstant {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `${field} must be a date or empty.` };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `${field} is not a date this site can read.` };
  }
  return { ok: true, value: parsed };
}

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A 24-hour "HH:MM" wall clock, or null when it is not one. */
export function parseWallClock(raw: unknown): string | null {
  return typeof raw === "string" && WALL_CLOCK.test(raw) ? raw : null;
}
