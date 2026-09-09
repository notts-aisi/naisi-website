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

/**
 * Whether ANSWERS to this stage may still be written.
 *
 * ## Why this predicate exists
 *
 * Until 9 September 2026 `effectiveStageClose` had exactly two call sites in
 * the repository, and neither was a write path: the reminder job read it, and
 * the `stage-released` email printed it. A stage deadline was therefore a
 * sentence in an email and nothing else. The only time gate on a stage submit
 * was the ROUND's window, so somebody told "Part 2 is due Friday 10 October"
 * could answer and file it on the 14th, with four days of thinking time nobody
 * else was offered, and the ordinary form rendered a live submit button while
 * they did it. That is the same fairness property the release boundary above
 * exists to protect, at the other end of the stage.
 *
 * A deadline a person is told about and that bounds their own write is
 * enforced by that write. `tests/deadlines-enforced.test.mjs` is the guard for
 * the class.
 *
 * ## Reading a closed stage is still allowed
 *
 * `isStageReleased` deliberately keeps saying yes after a deadline, so
 * reviewers can read the questions all through review week and an applicant
 * can look back at what they were asked. This predicate is the narrower one:
 * it answers only "may an answer be STORED", which is what the submit routes
 * and the draft save need to know.
 *
 * ## The ROUND's window is part of the answer, not a separate check
 *
 * Every write path calls `windowRefusal` before it gets here, so a round that
 * is not open already refuses. This predicate asks the same question anyway,
 * because it is also what the applicant's page is RENDERED against: a round an
 * admin closed early keeps a `closesAt` in the future, and a flag that said
 * "open for answers" about it would put a live form in front of somebody whose
 * every submission the server refuses. The flag and the gate have to be the
 * same sentence or they drift, which is the whole reason this module exists.
 *
 * ## Boundary semantics
 *
 * Inclusive at both ends, like every other bound in these modules: at the
 * release instant the stage is open, and at the close instant it still is. A
 * stage with no deadline of its own inherits the round's, and a round with no
 * deadline leaves it unbounded, which is a readiness-panel failure rather than
 * a state to render.
 */
export function isStageOpenForAnswers(
  stage: StageReleaseInput,
  round: RoundWindowInput,
  now: Date,
): boolean {
  if (roundWindowState(round, now).state !== "open") return false;
  if (!isStageReleased(stage, round, now)) return false;
  const close = effectiveStageClose(stage, round);
  if (!close) return true;
  return now.getTime() <= close.getTime();
}
