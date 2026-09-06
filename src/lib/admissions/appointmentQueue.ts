import { answerText } from "./answerText";
import {
  AVAILABILITY_DAYS,
  decodeMask,
  isUsableGrid,
  markedSlotCount,
  minuteLabel,
  slotCountFor,
  type AvailabilityGrid,
  type AvailabilityMask,
} from "./availability";
import type {
  AdmissionApplicationDoc,
  AdmissionApplicationStatus,
  AppointmentDecision,
} from "@/lib/firestore/admissionApplications";
import type { AdmissionStageDoc } from "@/lib/firestore/admissionRounds";
import type { CourseRunDoc, CourseRunStatus } from "@/lib/firestore/courses";

/**
 * The APPOINTMENT queue: the projection behind
 * `/admin/admissions/[roundId]/appointments`, and the small pure decisions the
 * decide route makes.
 *
 * ## Why this is a queue and not a review surface
 *
 * A facilitator round asks five or six people to run a group. That is a
 * different problem from ranking ninety applicants for forty places, and every
 * design that treated them as the same problem ended up scheduling the
 * appointment path behind the scoring machinery, which lands eleven days after
 * facilitator training starts. So: no blind review, no scores, no evidence
 * snapshot, no coverage. A list, the answers, when each person can be in a
 * room, and two buttons.
 *
 * ## The blinding is deliberately OFF, and the page says so
 *
 * `round.blind` governs the reviewing surfaces. This one shows names, because
 * appointing somebody to run a group for six weeks is a judgement about a
 * person the team knows and the pretence would help nobody. That is stated on
 * the page rather than left to be discovered.
 *
 * ## What may NOT reach this wire, and why the projection is field-by-field
 *
 * `AdmissionApplicationDoc` carries two things this surface must never carry,
 * and both would arrive on any spread of the document:
 *
 *  - `evidence.facilitatorNotes`, a facilitator's private written assessment
 *    of the applicant. It is the single sharpest reason the whole collection
 *    is `allow read: if false`, and nothing on an appointment queue needs it.
 *  - `outcome.reason` when the decider did not tick "share this". The shared
 *    half is projected; the unshared half is not projected at all, so a page
 *    cannot leak it by rendering the wrong field.
 *
 * The access-requirements answer is not on that list because it is not on this
 * document. It lives in the private sibling of this collection, behind its own
 * route, and every read of it is logged. This module holds no database handle
 * and names no collection, so it cannot reach it however it is called.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One answered question, as a label and a sentence. Rendered through MemberText. */
export type AppointmentAnswer = {
  questionId: string;
  label: string;
  /** The stored answer as one plain string, "" when unanswered. */
  text: string;
};

/** One stage's questions with this applicant's answers. */
export type AppointmentStageAnswers = {
  stageId: string;
  label: string;
  order: number;
  /**
   * Has this part been released to applicants yet? An unreleased stage has
   * nothing to answer, so the queue names it and stops rather than printing a
   * column of "Not answered".
   */
  released: boolean;
  answers: AppointmentAnswer[];
};

/** One weekday's marked availability as human spans, e.g. `["09:00-11:00"]`. */
export type AvailabilityDaySummary = {
  /** 0 = Sunday, matching `Date.getDay()` and `GroupSession.weekday`. */
  weekday: number;
  label: string;
  spans: string[];
};

export type AppointmentOutcomeSummary = {
  decision: AppointmentDecision;
  decidedAt: string | null;
  /** The run they were appointed to. Null on a decline. */
  runId: string | null;
  /** The decider's reason, and ONLY when they ticked "share this". */
  sharedReason: string;
};

export type AppointmentQueueRow = {
  applicationId: string;
  uid: string;
  /** The name on the account. Names are shown: this queue is not blind. */
  displayName: string;
  /** What they asked to be called, "" when they gave none. */
  preferredName: string;
  /** The address the site writes to, "" when the account has none. */
  email: string;
  /** Their verified university address, "" when they have not given one. */
  universityEmail: string;
  status: AdmissionApplicationStatus;
  submittedAt: string | null;
  /** The paid-membership badge AT APPLY TIME. Never a gate, only a fact. */
  membershipAtApply: boolean;
  stages: AppointmentStageAnswers[];
  availability: {
    /** Marked slots across the whole grid. 0 means they drew nothing. */
    markedSlots: number;
    days: AvailabilityDaySummary[];
  };
  outcome: AppointmentOutcomeSummary | null;
};

/** A run this round may appoint onto, as the queue's Select renders it. */
export type AppointmentRunOption = {
  id: string;
  label: string;
  courseTitle: string;
  /** Civil date "YYYY-MM-DD", or "" on a run with no start date yet. */
  startDate: string;
};

// ---------------------------------------------------------------------------
// Availability, as a compact per-day list
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * One drawn grid as a per-day list of contiguous spans.
 *
 * NOT the interactive grid component: that one is a client component built
 * around a pointer, it takes an `onChange` it would have nothing to do with
 * here, and a queue of a dozen applicants would render a dozen 252-cell grids
 * on a server-rendered page. A span list is the same information at a size a
 * person can read down a column, which is the actual job: "who can be in a
 * room on Tuesday evening".
 *
 * SPANS ARE HALF-OPEN and named by their real end time, so four marked
 * 15-minute slots from 09:00 read "09:00-10:00" rather than "09:00-09:45".
 * The earlier version named the last slot's START and every span read fifteen
 * minutes short, which on the one screen whose job is fitting people into
 * session slots is the kind of quiet error that puts somebody in a session
 * ending after they said they had to leave.
 *
 * A day with nothing marked is omitted entirely: a list of seven days where
 * five say "nothing" is harder to read than a list of two days.
 */
export function availabilityDaySummaries(
  mask: AvailabilityMask,
  fallbackGrid: AvailabilityGrid,
): AvailabilityDaySummary[] {
  const grid: AvailabilityGrid = isUsableGrid(mask) ? mask : fallbackGrid;
  if (!isUsableGrid(grid)) return [];
  const slots = slotCountFor(grid);
  const columns = decodeMask(mask.days, grid);
  const out: AvailabilityDaySummary[] = [];

  for (let day = 0; day < AVAILABILITY_DAYS; day += 1) {
    const column = columns[day] ?? [];
    const spans: string[] = [];
    let start: number | null = null;
    for (let slot = 0; slot <= slots; slot += 1) {
      const on = slot < slots && column[slot] === true;
      if (on && start === null) start = slot;
      if (!on && start !== null) {
        spans.push(
          `${minuteLabel(grid.startMinute + start * grid.slotMinutes)}-${minuteLabel(
            grid.startMinute + slot * grid.slotMinutes,
          )}`,
        );
        start = null;
      }
    }
    if (spans.length > 0) {
      out.push({ weekday: day, label: WEEKDAY_LABELS[day] ?? `Day ${day}`, spans });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * Everything the queue needs about the person, joined from their user
 * document. Passed in rather than read here so this module stays pure and the
 * loader owns every read.
 */
export type AppointmentApplicantProfile = {
  preferredName?: string;
  universityEmail?: string;
};

/**
 * One row, FIELD BY FIELD.
 *
 * A spread of the application document would send whatever it happens to
 * carry, which is a different set from what `AppointmentQueueRow` declares:
 * the type is checked at compile time and the object is built at run time, so
 * a field written by an older build or by a route that got ahead of the
 * normaliser would ride out to whoever asked. The two fields this surface must
 * never carry (a facilitator's private notes, an unshared rejection reason)
 * are both nested, so a key-by-key type check would not have caught them
 * either. Listing the fields is the guarantee.
 *
 * ANSWERS COME FROM THE STAGES, not from the stored answer map: a stage that
 * has been deleted or a question that has been removed should stop appearing
 * on this queue, and iterating the stored keys would keep rendering orphans
 * with no label to put on them.
 *
 * `releasedStageIds` is the loader's one clock reading, applied here rather
 * than re-read per stage so two stages on one page cannot land on opposite
 * sides of the same release instant. Omitting it treats every stage as
 * released, which is what a caller with no round to check against means.
 */
export function buildAppointmentQueueRow(
  application: AdmissionApplicationDoc,
  stages: AdmissionStageDoc[],
  grid: AvailabilityGrid,
  profile: AppointmentApplicantProfile | null,
  releasedStageIds?: ReadonlySet<string>,
): AppointmentQueueRow {
  const ordered = [...stages].sort((a, b) => a.order - b.order);
  const stageRows: AppointmentStageAnswers[] = ordered.map((stage) => {
    const stored = application.stageAnswers[stage.id] ?? {};
    const answers = stage.questions.map((question) => ({
      questionId: question.id,
      label: question.label,
      text: answerText(stored[question.id]),
    }));
    const released = releasedStageIds ? releasedStageIds.has(stage.id) : true;
    return {
      stageId: stage.id,
      label: stage.label,
      order: stage.order,
      released,
      // AN UNRELEASED STAGE KEEPS ONLY WHAT WAS ACTUALLY ANSWERED. Nobody has
      // been shown its questions, so the whole list would render as forty
      // "Not answered" rows between the decider and the answers they came for.
      // The answered ones are kept rather than the stage being dropped
      // outright because `isStageReleased` also goes false when a round is
      // cancelled or back in draft, and a round changing state must not hide
      // sentences somebody already wrote.
      answers: released ? answers : answers.filter((answer) => answer.text !== ""),
    };
  });

  const decision = application.outcome.decision;
  const appointmentDecision =
    decision === "appoint" || decision === "decline" ? decision : null;

  return {
    applicationId: application.id,
    uid: application.uid,
    displayName: application.displayName,
    preferredName: profile?.preferredName?.trim() ?? "",
    email: application.email ?? "",
    universityEmail: profile?.universityEmail?.trim() ?? "",
    status: application.status,
    submittedAt: application.submittedAt ? application.submittedAt.toISOString() : null,
    membershipAtApply: application.membershipAtApply,
    stages: stageRows,
    availability: {
      markedSlots: markedSlotCount(application.availability, grid),
      days: availabilityDaySummaries(application.availability, grid),
    },
    outcome: appointmentDecision
      ? {
          decision: appointmentDecision,
          decidedAt: application.outcome.decidedAt
            ? application.outcome.decidedAt.toISOString()
            : null,
          runId: application.outcome.targetRunId,
          // THE SHARE GATE. One line, and it is the only path `outcome.reason`
          // has off the document on this surface.
          sharedReason: application.outcome.reasonShared
            ? application.outcome.reason
            : "",
        }
      : null,
  };
}

/**
 * Undecided first, then most recently submitted.
 *
 * The queue is worked through in one sitting on the evening the round closes,
 * so the thing still needing a decision belongs at the top and a decided row
 * belongs where it can still be read. The tie-break is the applicant's own id,
 * which every row has, so the list cannot reshuffle between renders.
 */
export function sortAppointmentRows(
  rows: AppointmentQueueRow[],
): AppointmentQueueRow[] {
  return [...rows].sort((a, b) => {
    const aDecided = a.outcome ? 1 : 0;
    const bDecided = b.outcome ? 1 : 0;
    if (aDecided !== bDecided) return aDecided - bDecided;
    const at = Date.parse(a.submittedAt ?? "") || 0;
    const bt = Date.parse(b.submittedAt ?? "") || 0;
    if (at !== bt) return bt - at;
    return a.applicationId.localeCompare(b.applicationId);
  });
}

// ---------------------------------------------------------------------------
// The runs an appointment may target
// ---------------------------------------------------------------------------

/**
 * Runs this round may appoint somebody onto.
 *
 * NOT `round.outcomeRunIds`: an appointment round has none, by contract and by
 * the apply-side route's refusal. Its whole point is that it feeds no seat
 * rows. So the target is any run that could still want a facilitator, which is
 * every run that is not finished, not called off and not tidied away.
 *
 * A DRAFT RUN IS ELIGIBLE, deliberately. Facilitators are appointed in early
 * October for runs that start on the 26th and are still being written, so
 * refusing a draft would refuse the exact case this route exists for.
 */
export function eligibleAppointmentRuns(runs: CourseRunDoc[]): AppointmentRunOption[] {
  return runs
    .filter((run) => isAppointableRun(run))
    .map((run) => ({
      id: run.id,
      label: run.label,
      courseTitle: run.courseTitle,
      startDate: run.startDate,
    }))
    .sort(
      (a, b) =>
        a.courseTitle.localeCompare(b.courseTitle) || a.label.localeCompare(b.label),
    );
}

/**
 * The run statuses an appointment may still be made onto, as a list rather
 * than as the negation `isAppointableRun` used to spell out, so the loader can
 * hand the same rule to Firestore as a `where ... in` and read four statuses
 * instead of the whole collection.
 *
 * NOT paired with a `where` on `archived`: `createRun` does not write that
 * field, and a Firestore equality filter drops every document missing it. The
 * house rule about `orderBy` on sparse fields is the same rule. Archived is
 * checked below, on the documents that come back.
 */
export const APPOINTABLE_RUN_STATUSES = [
  "draft",
  "applications-open",
  "applications-closed",
  "running",
] as const satisfies readonly CourseRunStatus[];

/** The one predicate, so the queue's Select and the decide route agree. */
export function isAppointableRun(
  run: Pick<CourseRunDoc, "status" | "archived">,
): boolean {
  if (run.archived) return false;
  return (APPOINTABLE_RUN_STATUSES as readonly CourseRunStatus[]).includes(run.status);
}

// ---------------------------------------------------------------------------
// Whether the ROUND may be decided at all
// ---------------------------------------------------------------------------

/**
 * Why this round cannot be decided right now, or null when it can.
 *
 * Re-exported rather than defined here so the route and the queue page are
 * unchanged. It lives in `appointmentRules.ts` because the round editor is a
 * client component and asks the same question, and reaching it through this
 * module put the whole projection, and `server-only` behind it, into the
 * browser graph.
 */
export { appointmentDecideBlock } from "./appointmentRules";

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * What a decide request should do to an application that may already have been
 * decided. A pure function so both arms can be executed by a test rather than
 * reasoned about inside a transaction nothing can run.
 *
 *  - `proceed`: the row is `submitted` and this is its first decision.
 *  - `already-decided`: the SAME decision has already been recorded. The route
 *    answers 200 `{ alreadyDecided: true }`, moves no counter and sends no
 *    email. A double tap, a retried request, or two people pressing the same
 *    button must not mail somebody twice or drive a counter negative.
 *  - `conflict`: a DIFFERENT decision has already been recorded, or the row is
 *    not in a state that can be decided at all. Refused with 409, because
 *    silently overwriting a decision somebody else made, after the email for
 *    it has gone out, is not something a queue may do on its own.
 */
export type DecideDisposition =
  | { kind: "proceed" }
  | { kind: "already-decided" }
  | { kind: "conflict"; reason: string };

export function appointmentDecideDisposition(
  current: { status: AdmissionApplicationStatus; decision: AdmissionApplicationDoc["outcome"]["decision"] },
  requested: AppointmentDecision,
): DecideDisposition {
  if (current.status === "submitted" && current.decision === null) {
    return { kind: "proceed" };
  }
  if (current.decision === requested) return { kind: "already-decided" };
  if (current.decision !== null) {
    return {
      kind: "conflict",
      reason:
        "This application has already been decided, and the email for that decision has gone out. Nothing here can undo it: the application row has to be corrected directly, and if this is about who facilitates a run, that list is editable on the run's own roles page.",
    };
  }
  if (current.status === "draft") {
    return {
      kind: "conflict",
      reason: "This application is still a draft, so it has not been sent to us yet.",
    };
  }
  if (current.status === "withdrawn") {
    return {
      kind: "conflict",
      reason: "This person withdrew their application.",
    };
  }
  return {
    kind: "conflict",
    reason: "This application is not in a state that can be decided.",
  };
}
