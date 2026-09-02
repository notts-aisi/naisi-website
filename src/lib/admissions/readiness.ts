import type {
  AdmissionRoundKind,
  AdmissionRoundStatus,
} from "@/lib/firestore/admissionRounds";

/**
 * READINESS: everything that has to be true before a round may open, checked
 * in one place and reported as a list rather than as a boolean.
 *
 * ## Why this is a shared predicate and not a form validation
 *
 * The round document is authored across eight sections and opened from a
 * ninth. Nothing in the editor forces an order, and nothing should: an admin
 * drafts the window in September, adds criteria in October and appoints
 * reviewers the week before review. So "is this round finished" cannot be a
 * property of any one section's save, and a form that refused an incomplete
 * save would make drafting impossible.
 *
 * What it CAN be is a property checked at the boundary, and there is exactly
 * one boundary: the move from `draft` to `open`. After that a real applicant
 * can reach the form. A round opened without questions shows an empty form; a
 * round opened without a `closesAt` never closes and no deadline reminder can
 * be derived from it; a round opened without a final decider reaches decision
 * week with nobody able to press the button.
 *
 * Both the panel and the status route call this, so what the panel says is
 * missing IS what the route refuses on. A second opinion in either place
 * would be a screen that says green next to a button that says no.
 *
 * ## Why the checks carry a section id
 *
 * "Not ready" is useless on a page this long. Every check names the editor
 * section that fixes it, so the panel can render a link straight to it, which
 * is the difference between a blocker and a to-do list.
 */

export type ReadinessCheckId =
  | "stage-questions"
  | "closes-at"
  | "decisions-by"
  | "outcome-runs"
  | "reviewers"
  | "final-decider";

/** Editor section anchors. The panel links to `#${section}`. */
export type ReadinessSection =
  | "stages"
  | "window"
  | "outcomes"
  | "roles";

export type ReadinessCheck = {
  id: ReadinessCheckId;
  /** What is being asserted, in the affirmative: it reads as a tick. */
  label: string;
  ok: boolean;
  /** What to do about it. Empty when `ok`. */
  hint: string;
  section: ReadinessSection;
};

/** One stage, reduced to the only thing readiness has an opinion about. */
export type ReadinessStage = {
  id: string;
  order: number;
  questionCount: number;
};

/**
 * The round fields readiness depends on. Structural rather than
 * `AdmissionRoundDoc` so the predicate stays testable without building a whole
 * document, and so nothing here can quietly start reading a seventh field.
 */
export type ReadinessInput = {
  kind: AdmissionRoundKind;
  status: AdmissionRoundStatus;
  closesAt: Date | null;
  decisionsByDate: string | null;
  outcomeRunIds: string[];
  reviewerUids: string[];
  finalDeciderUid: string | null;
  stages: ReadinessStage[];
};

export type Readiness = {
  ready: boolean;
  checks: ReadinessCheck[];
  /** The failing subset, in the same order. What the refusal sentence lists. */
  unmet: ReadinessCheck[];
};

/**
 * The first stage in asked order. `order` is denormalised onto each stage from
 * its position in `round.stageIds`, so this does not need the round's list and
 * cannot disagree with it about which stage an applicant meets first.
 */
function firstStage(stages: ReadinessStage[]): ReadinessStage | null {
  if (stages.length === 0) return null;
  return stages.reduce((lowest, s) => (s.order < lowest.order ? s : lowest));
}

export function roundReadiness(round: ReadinessInput, now: Date): Readiness {
  const checks: ReadinessCheck[] = [];

  const first = firstStage(round.stages ?? []);
  checks.push({
    id: "stage-questions",
    label: "The first stage has at least one question",
    ok: first !== null && first.questionCount > 0,
    hint:
      first === null
        ? "Add a stage. A round with no stages shows an applicant an empty form."
        : "Add at least one question to the first stage, or an applicant reaches a form with nothing on it.",
    section: "stages",
  });

  const closesAt = round.closesAt ?? null;
  const closesInFuture = closesAt !== null && closesAt.getTime() > now.getTime();
  checks.push({
    id: "closes-at",
    label: "The deadline is set and still ahead",
    ok: closesInFuture,
    hint:
      closesAt === null
        ? "Set a closing date. Without one the round never closes and no deadline reminder can be worked out."
        : "The closing date has already passed, so opening the round would open a window that is over.",
    section: "window",
  });

  checks.push({
    id: "decisions-by",
    label: "Applicants are told when decisions land",
    ok: Boolean(round.decisionsByDate),
    hint: "Set the date decisions are promised by. It is shown publicly on the form.",
    section: "window",
  });

  // An appointment round (the facilitator intake) places nobody on a run, so
  // an outcome target would be a field with nothing legitimate to put in it.
  // The check is dropped rather than passed silently, so the panel never shows
  // a tick nobody earned.
  if (round.kind === "enrolment") {
    checks.push({
      id: "outcome-runs",
      label: "There is somewhere to place the people you accept",
      ok: (round.outcomeRunIds ?? []).length > 0,
      hint: "Pick at least one course run this round can offer places on.",
      section: "outcomes",
    });
  }

  checks.push({
    id: "reviewers",
    label: "At least one reviewer is appointed",
    ok: (round.reviewerUids ?? []).length > 0,
    hint: "Appoint reviewers. Membership of that list is the review permission itself.",
    section: "roles",
  });

  checks.push({
    id: "final-decider",
    label: "A final decider is named",
    ok: Boolean(round.finalDeciderUid),
    hint: "Name the person who sees the aggregates with names and presses decide.",
    section: "roles",
  });

  const unmet = checks.filter((c) => !c.ok);
  return { ready: unmet.length === 0, checks, unmet };
}

/** The refusal sentence the status route answers with. One line per blocker. */
export function readinessRefusal(unmet: ReadinessCheck[]): string {
  const items = unmet.map((c) => c.hint).join(" ");
  return `This round is not ready to open. ${items}`;
}
