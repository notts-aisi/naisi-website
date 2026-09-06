import {
  normalizeAvailabilityMask,
  AVAILABILITY_VERSION,
  DEFAULT_AVAILABILITY_GRID,
  type AvailabilityGrid,
  type AvailabilityMask,
} from "@/lib/admissions/availability";
import type { RsvpAnswer } from "./events";

/**
 * `admissionApplications/{roundId}__{uid}`: one person's application to one
 * round, from the first keystroke of a draft to the decision.
 *
 * ## The doc id is the invariant
 *
 * `admissionApplicationId(roundId, uid)` is DETERMINISTIC, which is the
 * structural one-application-per-(round, person) rule: the apply route uses
 * `tx.create()`, which throws ALREADY_EXISTS rather than quietly duplicating.
 * No uniqueness query, no race, the `courseApplications` precedent verbatim.
 * CONSTRUCT-ONLY: `roundId` and `uid` are stored as fields and the id is
 * never parsed back apart.
 *
 * ## Drafts live HERE, and nowhere near courseApplications
 *
 * A saved-but-unsubmitted application is a real server-side row with
 * `status: "draft"`, because the owner asked for drafts that survive a
 * refresh and a backgrounded phone. They are deliberately NOT a new member of
 * `CourseApplicationStatus`: `applications/route.ts` queries course
 * applications with no status filter at all, the queue sections on
 * `status !== "pending"` and marks only `withdrawn` read-only, and the decide
 * route maps any unrecognised status to `pending`. A half-written draft in
 * that collection would render in the Decided list with live accept buttons,
 * and accepting it would decrement a counter that was never incremented and
 * mail an acceptance. So drafts are structurally invisible to the seat-row
 * pipeline: they are a different collection.
 *
 * ## Why the row is `allow read, write: if false`, own-row read included
 *
 * The write half is obvious (counters on the round, a decision, PII). The
 * read half looks over-tight until you list what the row carries:
 *
 *  - `evidence.facilitatorNotes` is a facilitator's private written
 *    assessment of this applicant, gathered during the pre-course.
 *  - `outcome.reason` is the decider's rejection reason, and
 *    `outcome.reasonShared` is the tick that decides whether the applicant
 *    ever sees it.
 *
 * An own-row read hands both to the applicant from the browser console,
 * including the reason the decider deliberately did NOT share. The status hub
 * is an Admin SDK server component anyway, so the read rule bought nothing.
 * If an own-row read is ever wanted, those fields move to a routes-only
 * sibling FIRST.
 *
 * The access-requirements answer is not on this list because it is not on
 * this document: it lives in `admissionApplicationPrivate` at the same id.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type AdmissionApplicationStatus =
  | "draft"
  | "submitted"
  | "accepted"
  | "fellowship-offered"
  | "waitlisted"
  | "rejected"
  | "withdrawn"
  | "appointed";

export const ADMISSION_APPLICATION_STATUSES: AdmissionApplicationStatus[] = [
  "draft",
  "submitted",
  "accepted",
  "fellowship-offered",
  "waitlisted",
  "rejected",
  "withdrawn",
  "appointed",
];

export const ADMISSION_APPLICATION_STATUS_LABEL: Record<
  AdmissionApplicationStatus,
  string
> = {
  draft: "Draft",
  submitted: "Submitted",
  accepted: "Accepted",
  "fellowship-offered": "Offered a fellowship place",
  waitlisted: "Waitlisted",
  rejected: "Not offered a place",
  withdrawn: "Withdrawn",
  appointed: "Appointed",
};

/**
 * What the final decider pressed. Distinct from the resulting status.
 *
 * The last two belong to an APPOINTMENT round (`round.kind`), where the
 * outcome is a facilitator role on a run rather than a seat on one. They are
 * members of the same union rather than a second enum because
 * `outcome.decision` is one field on one document, and a normaliser that had
 * to know the round's kind before it could tell a stored value from a corrupt
 * one would be reading two documents to read one.
 *
 * Nothing mixes the two sets: the decide route refuses an enrolment decision
 * on an appointment round, and the enrolment half of that route does not exist
 * yet.
 */
export type AdmissionDecision =
  | "accept"
  | "offer-fellowship"
  | "waitlist"
  | "reject"
  | "appoint"
  | "decline";

export const ADMISSION_DECISIONS: AdmissionDecision[] = [
  "accept",
  "offer-fellowship",
  "waitlist",
  "reject",
  "appoint",
  "decline",
];

/** The decisions an APPOINTMENT round may take. The decide route's whitelist. */
export const APPOINTMENT_DECISIONS = ["appoint", "decline"] as const;

export type AppointmentDecision = (typeof APPOINTMENT_DECISIONS)[number];

export function isAppointmentDecision(v: unknown): v is AppointmentDecision {
  return (
    typeof v === "string" && (APPOINTMENT_DECISIONS as readonly string[]).includes(v)
  );
}

/**
 * The status a decision lands the application in. One place, so decide and
 * recount agree.
 *
 * `appoint` gets its OWN status rather than reusing `accepted`. The two are
 * different endings and the applicant reads about them on the same hub: an
 * accepted enrolment applicant has a place on a course, an appointed
 * facilitator is being asked to run a group. Sharing a status would have made
 * the hub tell one of them the other's sentence. `decline` reuses `rejected`,
 * because that ending IS the same ending; the hub's sentence for it is chosen
 * by the round's kind rather than by a second status member nobody needed.
 */
export const DECISION_STATUS: Record<AdmissionDecision, AdmissionApplicationStatus> = {
  accept: "accepted",
  "offer-fellowship": "fellowship-offered",
  waitlist: "waitlisted",
  reject: "rejected",
  appoint: "appointed",
  decline: "rejected",
};

// ---------------------------------------------------------------------------
// Field budgets
// ---------------------------------------------------------------------------

/**
 * The routes are the security boundary; these power the form's counters and
 * the normaliser's slicing. Per-question answer caps are NOT here: they live
 * on each `FormQuestion.maxLength` and are enforced by `validateAnswers`,
 * because an incubator essay and a one-line name field want different budgets
 * and a single number for both is how you get a 300-word answer cut at 80.
 */
export const ADMISSION_APPLICATION_FIELD_LIMITS = {
  maxStages: 8,
  maxRankedFellowships: 8,
  facilitatorNotes: 2000,
  outcomeReason: 1000,
  maxEvidenceRuns: 6,
} as const;

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/** The applicant's ANSWER to the round's programme-preference section. */
export type ApplicationProgrammePreference = {
  /** The incubator stream they picked, or null for none. */
  streamId: string | null;
  /** Fellowships in preference order. Ids from `round.programmePreference`. */
  rankedFellowshipIds: string[];
  /** "If not the incubator, I would take a fellowship place." */
  openToFellowship: boolean;
};

export const EMPTY_APPLICATION_PROGRAMME_PREFERENCE: ApplicationProgrammePreference = {
  streamId: null,
  rankedFellowshipIds: [],
  openToFellowship: false,
};

/** One evidence run's attendance and submission rollup, frozen at submit. */
export type EvidenceRunSnapshot = {
  runId: string;
  /** Sessions the group actually held. The denominator; 0 means no register yet. */
  sessionsHeld: number;
  attendedInFull: number;
  submissionDone: boolean;
};

/**
 * The pre-course evidence a reviewer scores alongside the written answers,
 * FROZEN at submit so a late register edit cannot move the ground under an
 * in-flight review. A stale chip is derived at read time by comparing
 * `computedAt` against the evidence run's last register write; recomputing is
 * an explicit, audited human act and never automatic.
 *
 * `facilitatorNotes` is the joined free text a facilitator wrote about this
 * person during the pre-course. It is REVIEWER-ONLY and is the single
 * sharpest reason this whole document is `allow read: if false`.
 */
export type EvidenceSnapshot = {
  runs: EvidenceRunSnapshot[];
  facilitatorNotes: string;
  computedAt: Date | null;
};

export type AdmissionOutcome = {
  decision: AdmissionDecision | null;
  /** The run the seat was minted on. Null for a reject or a waitlist. */
  targetRunId: string | null;
  /** The stream on that run, when the run has streams. */
  streamId: string | null;
  decidedByUid: string | null;
  decidedAt: Date | null;
  /** The decider's message. NEVER shown to the applicant unless `reasonShared`. */
  reason: string;
  reasonShared: boolean;
};

export const EMPTY_OUTCOME: AdmissionOutcome = {
  decision: null,
  targetRunId: null,
  streamId: null,
  decidedByUid: null,
  decidedAt: null,
  reason: "",
  reasonShared: false,
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export type AdmissionApplicationDoc = {
  /** Firestore doc id: `admissionApplicationId(roundId, uid)`. */
  id: string;
  roundId: string;
  uid: string;
  /**
   * Server-sourced from the session user, never client-supplied, so an
   * applicant cannot plant someone else's address. Stripped from every blind
   * reviewer payload.
   */
  email: string | null;
  /** Denormalised so review lists render without a users read. Blinded per round. */
  displayName: string;
  /**
   * Answers keyed by stage id, then by question id. Nested rather than flat
   * because a stage is the unit of release AND the unit of freezing: with a
   * flat map, "which answers are locked" would have to be recomputed from the
   * round's stage list on every write.
   *
   * Every value is coerced to the `RsvpAnswer` union on read, and a value
   * outside it is dropped rather than passed through: see `asRsvpAnswer`.
   */
  stageAnswers: Record<string, Record<string, RsvpAnswer>>;
  /** When each stage was frozen. A stage with no entry is still editable. */
  stageSubmittedAt: Record<string, Date | null>;
  /** The drawn grid, carrying the geometry it was drawn on. */
  availability: AvailabilityMask;
  /**
   * The grid VERSION the answer was drawn on, denormalised out of
   * `availability` so a staleness scan is one equality filter rather than a
   * full read of every application. It is a copy, not the truth: every decode
   * reads the geometry stored inside `availability` itself.
   */
  availabilityConfigVersion: number;
  programmePreference: ApplicationProgrammePreference;
  /** Null until the evidence builder runs at submit. */
  evidence: EvidenceSnapshot | null;
  /**
   * Snapshot of the paid-membership badge AT APPLY TIME. A snapshot, not a
   * live read, so the decisions surface shows what was true when they
   * applied. Shown to the final decider and admins only, never to a blind
   * reviewer, and never a gate: an unpaid applicant is told to buy
   * membership by email, not refused.
   */
  membershipAtApply: boolean;
  /**
   * How many times this person has withdrawn and applied again in this round.
   * Withdrawal is NOT terminal while the window is open, so the row is reused
   * rather than replaced and this is the only record that it happened.
   */
  reapplyCount: number;
  status: AdmissionApplicationStatus;
  submittedAt: Date | null;
  /**
   * When THE APPLICANT withdrew, and only that. A system release (the run
   * destroy cascade moving a placed applicant to `withdrawn` because their
   * cohort no longer exists) deliberately leaves this null rather than
   * back-dating an act the person never performed, so a null here alongside
   * `status: "withdrawn"` is expected and is not a missing write. See
   * `releaseAdmissionSeats` in courseDeletion.ts.
   */
  withdrawnAt: Date | null;
  outcome: AdmissionOutcome;
  /**
   * The `courseApplications` seat row this outcome minted, stored so the
   * decide route can RECONCILE rather than guess. Reject-after-accept and
   * accept-into-a-different-run both have to move the row that already
   * exists, and a guessed id would move the wrong one (or none) the moment a
   * decision changes the target run.
   */
  seatApplicationId: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * The collection name, HERE rather than beside the apply tree's handlers.
 *
 * It lives with the shape it names so that a module needing only "which
 * collection is this" can have it without importing `applyContext.ts`, which
 * can reach `admissionApplicationPrivate` (the access-requirements answer) and
 * which `tests/privacy-policy.test.mjs` therefore treats as reaching it. The
 * status hub's loader is the module that made the difference matter: it must be
 * provably unable to touch that collection, and an import for a string constant
 * is not a reason to give up the proof.
 */
export const APPLICATIONS_COLLECTION = "admissionApplications";

/**
 * Deterministic doc id: one application per (round, person), enforced by
 * `tx.create()` on this id. CONSTRUCT-ONLY (see the module comment).
 */
export function admissionApplicationId(roundId: string, uid: string): string {
  return `${roundId}__${uid}`;
}

/**
 * The `admissionApplicationPrivate` row for an application shares its id
 * exactly, which is what makes both the destroy cascade and the
 * account-deletion sweep ADDRESSED deletes rather than queries.
 */
export function admissionApplicationPrivateId(roundId: string, uid: string): string {
  return admissionApplicationId(roundId, uid);
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max?: number): string {
  const s = typeof v === "string" ? v : "";
  return max === undefined ? s : s.slice(0, max);
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}

/**
 * One stored answer, coerced to the `RsvpAnswer` union rather than asserted
 * into it.
 *
 * The write side already validates: the apply and submit routes run every
 * answer through the events `validateAnswers`, so a well-formed row cannot
 * contain anything this drops. It is the ill-formed row this exists for. A
 * value outside the union is not an answer any renderer can draw (they switch
 * on exactly these four shapes), so admitting one buys a `[object Object]` on
 * a reviewer's screen at best and a throw at worst, and the reviewer would
 * have no way to tell a corrupt cell from an empty one.
 *
 * Unknown values become `null`, which the caller drops, so the question reads
 * as unanswered. That is the honest rendering of a value nothing can read.
 */
function asRsvpAnswer(v: unknown): RsvpAnswer | null {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object") {
    const raw = v as Raw;
    // The checkbox-with-other shape. Both keys must be present and the right
    // type; a map that merely happens to be an object is not one of these.
    if (Array.isArray(raw.checked) && typeof raw.other === "string") {
      return {
        checked: raw.checked.filter((x): x is string => typeof x === "string"),
        other: raw.other,
      };
    }
  }
  return null;
}

function asStageAnswers(v: unknown): Record<string, Record<string, RsvpAnswer>> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, Record<string, RsvpAnswer>> = {};
  let stages = 0;
  for (const [stageId, answers] of Object.entries(v as Raw)) {
    if (stages >= ADMISSION_APPLICATION_FIELD_LIMITS.maxStages) break;
    if (!answers || typeof answers !== "object") continue;
    const stage: Record<string, RsvpAnswer> = {};
    for (const [questionId, answer] of Object.entries(answers as Raw)) {
      const coerced = asRsvpAnswer(answer);
      if (coerced !== null) stage[questionId] = coerced;
    }
    out[stageId] = stage;
    stages += 1;
  }
  return out;
}

function asStageSubmittedAt(v: unknown): Record<string, Date | null> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, Date | null> = {};
  let stages = 0;
  for (const [stageId, at] of Object.entries(v as Raw)) {
    if (stages >= ADMISSION_APPLICATION_FIELD_LIMITS.maxStages) break;
    out[stageId] = tsToDate(at);
    stages += 1;
  }
  return out;
}

function asProgrammePreference(v: unknown): ApplicationProgrammePreference {
  const raw = (v ?? {}) as Raw;
  const ranked = Array.isArray(raw.rankedFellowshipIds)
    ? raw.rankedFellowshipIds
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .slice(0, ADMISSION_APPLICATION_FIELD_LIMITS.maxRankedFellowships)
    : [];
  return {
    streamId: str(raw.streamId) || null,
    rankedFellowshipIds: ranked,
    openToFellowship: raw.openToFellowship === true,
  };
}

function asEvidence(v: unknown): EvidenceSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Raw;
  const L = ADMISSION_APPLICATION_FIELD_LIMITS;
  const runs: EvidenceRunSnapshot[] = [];
  if (Array.isArray(raw.runs)) {
    for (const entry of raw.runs) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Raw;
      const runId = str(r.runId);
      if (!runId) continue;
      runs.push({
        runId,
        sessionsHeld: Math.max(0, int(r.sessionsHeld, 0)),
        attendedInFull: Math.max(0, int(r.attendedInFull, 0)),
        submissionDone: r.submissionDone === true,
      });
      if (runs.length >= L.maxEvidenceRuns) break;
    }
  }
  return {
    runs,
    facilitatorNotes: str(raw.facilitatorNotes, L.facilitatorNotes),
    computedAt: tsToDate(raw.computedAt),
  };
}

function asOutcome(v: unknown): AdmissionOutcome {
  const raw = (v ?? {}) as Raw;
  const decision = raw.decision as AdmissionDecision;
  return {
    decision: ADMISSION_DECISIONS.includes(decision) ? decision : null,
    targetRunId: str(raw.targetRunId) || null,
    streamId: str(raw.streamId) || null,
    decidedByUid: str(raw.decidedByUid) || null,
    decidedAt: tsToDate(raw.decidedAt),
    reason: str(raw.reason, ADMISSION_APPLICATION_FIELD_LIMITS.outcomeReason),
    reasonShared: raw.reasonShared === true,
  };
}

/**
 * `grid` is the ROUND's current geometry, and is used only as the fallback
 * for an answer stored before the geometry travelled with it. Passing the
 * wrong round's grid cannot corrupt a well-formed answer, because a
 * well-formed answer ignores it.
 */
export function normalizeAdmissionApplication(
  id: string,
  data: Raw,
  grid: AvailabilityGrid = DEFAULT_AVAILABILITY_GRID,
): AdmissionApplicationDoc {
  const status = data.status as AdmissionApplicationStatus;
  const availability = normalizeAvailabilityMask(data.availability, grid);
  return {
    id,
    roundId: str(data.roundId),
    uid: str(data.uid),
    email: str(data.email) || null,
    displayName: str(data.displayName),
    stageAnswers: asStageAnswers(data.stageAnswers),
    stageSubmittedAt: asStageSubmittedAt(data.stageSubmittedAt),
    availability,
    availabilityConfigVersion: int(
      data.availabilityConfigVersion,
      availability.version || AVAILABILITY_VERSION,
    ),
    programmePreference: asProgrammePreference(data.programmePreference),
    evidence: asEvidence(data.evidence),
    membershipAtApply: data.membershipAtApply === true,
    reapplyCount: Math.max(0, int(data.reapplyCount, 0)),
    status: ADMISSION_APPLICATION_STATUSES.includes(status) ? status : "draft",
    submittedAt: tsToDate(data.submittedAt),
    withdrawnAt: tsToDate(data.withdrawnAt),
    outcome: asOutcome(data.outcome),
    seatApplicationId: str(data.seatApplicationId) || null,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}
