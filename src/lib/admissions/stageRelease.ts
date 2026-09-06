import { isValidDateKey, londonWallClockToInstant } from "@/lib/courses/weekPlan";
import { roundWindowState, type RoundWindowInput } from "./window";

/**
 * The RELEASE BOUNDARY: when a stage's questions may be handed out, and when
 * the answers to them are due.
 *
 * ## Why this is a boundary and not a display rule
 *
 * The autumn round releases its questions weekly, on dates announced up
 * front. That is a promise about fairness, not a piece of chrome: an
 * applicant who can read week three's essay question in week one has a
 * fortnight of thinking time nobody else got.
 *
 * The V2 shape could not keep that promise. Questions authored on a run
 * document were readable by any signed-in account the moment they were saved
 * (`courseRuns` is `allow read: if isSignedIn()`), so a timed release there
 * was cosmetic: the questions were already on the wire, and hiding them was a
 * `display: none` an applicant's devtools would undo. Stages therefore live
 * in `admissionRounds/{roundId}/stages/{stageId}`, which is
 * `allow read, write: if false`, and the ONLY way a question reaches a
 * browser is a route that has called `isStageReleased` first.
 *
 * So this predicate is the whole guarantee. Nothing else enforces it.
 *
 * ## The three ways a stage becomes released
 *
 *  1. **With the round.** `releaseAt: null` means "this stage is the form",
 *     the single-stage case, which is how the autumn round runs if the
 *     multi-stage work is descoped. It releases the moment the round's window
 *     opens and not a second earlier.
 *  2. **On its scheduled date.** `releaseAt` is a CIVIL date in
 *     Europe/London, with `releaseTimeLocal` as the wall clock on that day,
 *     because "released on Monday" is what was announced and a stored instant
 *     would need re-deriving every time the clocks changed. The conversion
 *     goes through `londonWallClockToInstant`, which handles the fold and the
 *     gap explicitly.
 *  3. **By hand.** `manualReleasedAt` is stamped by
 *     `POST .../stages/[stageId]/release`. It can only ever bring a release
 *     FORWARD: an admin who needs the questions out early presses the button,
 *     and the scheduled date is then irrelevant. It cannot push one back,
 *     because a question already served cannot be unserved.
 *
 * All three are gated behind the round's own window first. A stage of a
 * `draft` round is never released, however its dates read, and neither is a
 * stage of a CANCELLED round: cancelling a round is a decision to stop
 * asking, and handing out a fresh question afterwards would contradict it.
 * (An applicant's own saved answers live on their application row, not on the
 * stage, so nothing they have already written disappears with this.)
 *
 * ## Boundary semantics
 *
 * Inclusive, like every other date bound in the admissions modules: at the
 * release instant itself the stage IS released.
 */

/**
 * The stage fields the release boundary depends on. Structural rather than
 * `AdmissionStageDoc` so the predicate stays testable without a whole
 * document, and so nothing here can quietly start reading a sixth field.
 */
export type StageReleaseInput = {
  /** Civil date key ("YYYY-MM-DD", Europe/London). Null = release with the round. */
  releaseAt: string | null;
  /** Wall clock on `releaseAt`, 24-hour "HH:MM". */
  releaseTimeLocal: string;
  /** Set by the manual release route. Only ever brings a release forward. */
  manualReleasedAt: Date | null;
  /** Stage-specific deadline. Null = the round's own `closesAt`. */
  closesAt: Date | null;
};

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The wall clock a stage releases at when it does not name one of its own. */
export const DEFAULT_STAGE_RELEASE_TIME = "09:00";

/**
 * The instant a stage's SCHEDULE says it releases, or null when it has no
 * schedule (and therefore rides the round's opening).
 *
 * A malformed `releaseAt` returns null rather than throwing. That direction
 * is deliberate but it is not free: it means a stage whose date was somehow
 * stored as `2026-02-31` releases WITH THE ROUND rather than on a date that
 * does not exist. The alternative is a route that 500s on a half-authored
 * round, and the readiness panel (PR8) is what stops a malformed date
 * reaching an open round in the first place. `isValidDateKey` is the same
 * round-tripping check the run start date uses, so `2026-02-31` is caught
 * here rather than silently rolling into March.
 */
export function stageReleaseInstant(stage: StageReleaseInput): Date | null {
  const key = stage?.releaseAt ?? null;
  if (typeof key !== "string" || !isValidDateKey(key)) return null;
  const raw = stage.releaseTimeLocal;
  const hhmm = typeof raw === "string" && WALL_CLOCK.test(raw)
    ? raw
    : DEFAULT_STAGE_RELEASE_TIME;
  return londonWallClockToInstant(key, hhmm);
}

/** True when this stage's questions may be served. See the module comment. */
export function isStageReleased(
  stage: StageReleaseInput,
  round: RoundWindowInput,
  now: Date,
): boolean {
  // A cancelled round stops asking. `roundWindowState` calls it "closed" (it
  // mirrors the courses predicate, whose question is only "can you apply"),
  // so the distinction is drawn here, where it matters.
  if (round?.status === "cancelled") return false;

  const state = roundWindowState(round, now).state;
  // `inactive` is draft or archived; `not-yet` is a round whose window has
  // not opened. Neither may serve a question. `closed` still may: reviewers
  // read the questions all through review week, and an applicant may look
  // back at what they were asked.
  if (state === "inactive" || state === "not-yet") return false;

  const manual = stage?.manualReleasedAt ?? null;
  if (manual && manual.getTime() <= now.getTime()) return true;

  const scheduled = stageReleaseInstant(stage);
  if (scheduled === null) return true;
  return now.getTime() >= scheduled.getTime();
}

/**
 * When answers to this stage are due.
 *
 * A stage may carry its own earlier deadline (the weekly-question shape: each
 * stage closes before the next opens). It may NOT carry a later one: the
 * round's `closesAt` is the last instant the submit route accepts anything at
 * all, so a stage deadline beyond it is a date nobody can meet, and printing
 * it would be the discovery-versus-submit disagreement the window module
 * exists to prevent, one level down.
 *
 * Null out means unbounded, which happens only when the round itself has no
 * deadline set. That is a readiness-panel failure, not a state to render.
 */
export function effectiveStageClose(
  stage: StageReleaseInput,
  round: Pick<RoundWindowInput, "closesAt">,
): Date | null {
  const roundClose = round?.closesAt ?? null;
  const stageClose = stage?.closesAt ?? null;
  if (!stageClose) return roundClose;
  if (!roundClose) return stageClose;
  return stageClose.getTime() < roundClose.getTime() ? stageClose : roundClose;
}
