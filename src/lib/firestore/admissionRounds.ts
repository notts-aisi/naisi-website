import {
  normalizeAvailabilityGrid,
  type AvailabilityGrid,
} from "@/lib/admissions/availability";
import { sanitizeSignupForm, type FormQuestion } from "./events";
import {
  ADMISSION_APPLICATION_STATUSES,
  type AdmissionApplicationStatus,
} from "./admissionApplications";
import { slugId } from "./slugId";

/**
 * `admissionRounds/{roundId}` — one intake. The object an applicant applies
 * TO, and the object a reviewer reviews FOR.
 *
 * ## Why this is not a field on a course run
 *
 * V2 hung applications off `courseRuns.applicationForm`, which made "the
 * thing you apply to" and "the thing you are placed on" the same document.
 * That does not survive contact with the autumn intake: one round feeds the
 * research incubator AND up to three fellowship runs, an incubator reject is
 * offered a fellowship place, and the facilitator round feeds no run at all.
 * A round is therefore its own object with `outcomeRunIds` pointing at the
 * runs it can place people on, and the round id is NEVER derived from a run
 * id.
 *
 * ## Routes-only, and read:false as well as write:false
 *
 * Rules are `allow read, write: if false` for the round AND its stages. The
 * write half is the usual reason (counters, role arrays, PII adjacency). The
 * READ half is the sharper one and is worth stating, because a signed-in read
 * looks harmless:
 *
 *  - `applicationCounts` is live. Signed-in-readable, any fresher can watch a
 *    competitive intake's submitted / accepted / rejected counters move in
 *    real time, all through the week their own application is being decided.
 *  - `finalDeciderUid` names the person who decides their application.
 *  - `criteria` carries the guidance reviewers score against.
 *
 * Every staff surface reads a round through `GET /api/admissions/rounds` and
 * the public round page is a server component on the Admin SDK, so the read
 * rule bought nothing anyway. It also removes the question of a `get()` in a
 * read rule entirely: there is no read rule to put one in.
 *
 * ## THE ROUND DOCUMENT CARRIES NO `questions` FIELD
 *
 * Not a style rule. Question text lives ONLY in the `stages` subcollection,
 * whose whole existence is the timed-release guarantee (see
 * `src/lib/admissions/stageRelease.ts`). Any copy of a question onto a
 * document a client can read defeats it, and this is the shape that makes the
 * mistake structurally hard rather than merely discouraged. The emulator
 * suite asserts that no document under a client-readable path carries a
 * `questions` key.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * `enrolment` rounds place people onto course runs (the autumn intake).
 * `appointment` rounds appoint people to a job (the facilitator round, whose
 * outcome is an appointment to a run rather than a seat on one).
 */
export type AdmissionRoundKind = "enrolment" | "appointment";

export const ADMISSION_ROUND_KINDS: AdmissionRoundKind[] = ["enrolment", "appointment"];

export const ADMISSION_ROUND_KIND_LABEL: Record<AdmissionRoundKind, string> = {
  enrolment: "Places on a course",
  appointment: "An appointment",
};

export type AdmissionRoundStatus =
  | "draft"
  | "open"
  | "closed"
  | "deciding"
  | "settled"
  | "cancelled";

export const ADMISSION_ROUND_STATUSES: AdmissionRoundStatus[] = [
  "draft",
  "open",
  "closed",
  "deciding",
  "settled",
  "cancelled",
];

export const ADMISSION_ROUND_STATUS_LABEL: Record<AdmissionRoundStatus, string> = {
  draft: "Draft",
  open: "Open for applications",
  closed: "Closed",
  deciding: "Deciding",
  settled: "Settled",
  cancelled: "Cancelled",
};

/**
 * The status transition table lives in ONE place, the status route
 * (`POST /api/admissions/rounds/[roundId]/status`), and is reproduced here
 * only so a reader of the data layer can see the shape of the machine.
 *
 * That is safe ONLY because `admissionRounds` is `allow write: if false`, so
 * the route is the sole writer. If that rule is ever relaxed, this table has
 * to be duplicated into rules in the same change, or the machine is three
 * client writes away from being walked backwards (the lesson from
 * `canApproveCourse()` being able to move a live run back to draft).
 */
export const ADMISSION_ROUND_TRANSITIONS: Record<
  AdmissionRoundStatus,
  AdmissionRoundStatus[]
> = {
  draft: ["open", "cancelled"],
  open: ["closed", "cancelled"],
  // `closed -> open` is the extend-the-window path and needs an explicit
  // confirmation at the route: it re-opens a form people have been told is
  // shut.
  closed: ["deciding", "open"],
  deciding: ["settled"],
  settled: [],
  cancelled: [],
};

/** The reminder schedule ids a round may carry. */
export type ReminderOffsetId = "t7" | "t3" | "dday";

export const REMINDER_OFFSET_IDS: ReminderOffsetId[] = ["t7", "t3", "dday"];

/**
 * One scheduled nudge to everyone still holding an unsubmitted draft.
 *
 * The scheduler marker keys on the RESOLVED civil due date, never on `id`
 * (`remind__{roundId}__{uid}__{dueAtKey}`), so editing a round's schedule
 * cannot re-send an offset that has already gone out.
 */
export type ReminderOffset = {
  id: ReminderOffsetId;
  /** Days before `closesAt`. 0 is deadline day. */
  daysBefore: number;
  /** London wall clock on that day, 24-hour "HH:MM". */
  atLocalTime: string;
};

export const DEFAULT_REMINDER_OFFSETS: ReminderOffset[] = [
  { id: "t7", daysBefore: 7, atLocalTime: "10:00" },
  { id: "t3", daysBefore: 3, atLocalTime: "10:00" },
  { id: "dday", daysBefore: 0, atLocalTime: "12:00" },
];

// ---------------------------------------------------------------------------
// Field budgets
// ---------------------------------------------------------------------------

/**
 * Field budgets for round authoring. The routes are the security boundary;
 * these power the editor's `maxLength` attributes and counters, the same
 * split as `users.FIELD_LIMITS`. Question-answer caps are separate and live
 * on each question (`FormQuestion.maxLength`).
 */
export const ADMISSION_ROUND_FIELD_LIMITS = {
  label: 80,
  slug: 60,
  blurb: 2000,
  academicYear: 9,
  accessRequirementsPrompt: 500,
  criterionLabel: 80,
  criterionGuidance: 500,
  maxCriteria: 10,
  maxStages: 8,
  maxReviewers: 40,
  maxEvidenceRuns: 6,
  maxOutcomeRuns: 8,
  maxReminderOffsets: 5,
  maxProgrammeOptions: 8,
  programmeOptionLabel: 80,
  stageLabel: 80,
  stageIntro: 2000,
  maxStageQuestions: 20,
  minScore: 0,
  maxScore: 10,
} as const;

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/** One scored criterion. `id` is stable; a review's `scores` map keys on it. */
export type AdmissionCriterion = {
  id: string;
  label: string;
  /** What a reviewer should be looking for. Shown in the scoring panel. */
  guidance: string;
};

/** The integer range a criterion is scored on, inclusive at both ends. */
export type AdmissionScoreScale = {
  min: number;
  max: number;
};

export const DEFAULT_SCORE_SCALE: AdmissionScoreScale = { min: 1, max: 5 };

/**
 * What a reviewer may NOT see. Admins and the final decider are never blind;
 * this applies to everyone else in `reviewerUids`.
 *
 * `hideMembership` is separate from `hideNames` because it answers a
 * different question. Names are hidden so a reviewer cannot recognise a
 * friend; the paid-membership badge is hidden because membership must not
 * affect the decision at all, and a reviewer who can see it cannot prove to
 * themselves that it did not.
 */
export type AdmissionBlindSettings = {
  hideNames: boolean;
  hideMembership: boolean;
};

export const DEFAULT_BLIND_SETTINGS: AdmissionBlindSettings = {
  hideNames: true,
  hideMembership: true,
};

/** One selectable programme: an incubator stream or a fellowship. */
export type ProgrammeOption = {
  id: string;
  label: string;
};

/**
 * The programme-preference SECTION as the round authors it. The applicant's
 * ANSWER to it is `AdmissionApplicationDoc.programmePreference`, which is a
 * different shape in a different file.
 *
 * The incubator and the fellowships run concurrently and start the same week,
 * so one round asks about both: an applicant picks an incubator stream, ranks
 * fellowships, or does both, and an incubator reject can then be offered a
 * fellowship place without a second application.
 */
export type RoundProgrammePreference = {
  /** False = this round asks nothing about programme choice. */
  enabled: boolean;
  /** Incubator streams. An applicant picks at most one. */
  streams: ProgrammeOption[];
  /** Fellowships. An applicant ranks up to `maxRankedFellowships` of them. */
  fellowships: ProgrammeOption[];
  maxRankedFellowships: number;
  /**
   * Whether the form asks "if we cannot offer you the incubator, would you
   * take a fellowship place?". This is what makes the offer-fellowship
   * decision an offer rather than a surprise.
   */
  offerFellowshipFallback: boolean;
};

export const EMPTY_PROGRAMME_PREFERENCE: RoundProgrammePreference = {
  enabled: false,
  streams: [],
  fellowships: [],
  maxRankedFellowships: 2,
  offerFellowshipFallback: false,
};

/** One count per application status. Server-owned; moved only in a transaction. */
export type AdmissionApplicationCounts = Record<AdmissionApplicationStatus, number>;

export function zeroApplicationCounts(): AdmissionApplicationCounts {
  const counts = {} as AdmissionApplicationCounts;
  for (const status of ADMISSION_APPLICATION_STATUSES) counts[status] = 0;
  return counts;
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

export type AdmissionRoundDoc = {
  /** Firestore doc id: `admissionRoundId(label)`. Never derived from a run id. */
  id: string;
  kind: AdmissionRoundKind;
  /** Admin-facing name, and the string a destroy confirmation would compare. */
  label: string;
  /** Public url segment. Stable once the round opens. */
  slug: string;
  /** Public standfirst on the round page. Plain text, rendered as a text node. */
  blurb: string;
  /** "2026/27", the same string shape `users.paidMembershipYears` stores. */
  academicYear: string;
  status: AdmissionRoundStatus;
  /** Instants, not civil dates: the authoring route derives them from the
   *  dates an admin typed, in Europe/London, and stores the result. */
  opensAt: Date | null;
  closesAt: Date | null;
  /**
   * The date decisions are promised by, as a CIVIL date key
   * ("YYYY-MM-DD", Europe/London). A civil date because it is a promise about
   * a day, displayed publicly, and never compared against an instant. It does
   * NOT also live on a course run: two fields naming the same date is exactly
   * the drift this contract exists to stop.
   */
  decisionsByDate: string | null;
  /** Stage ids in ASKED order. The subcollection is addressed from this list. */
  stageIds: string[];
  programmePreference: RoundProgrammePreference;
  availabilityGrid: AvailabilityGrid;
  /**
   * The wording of the access-requirements question. The ANSWER never lands
   * here or on the application: it goes to `admissionApplicationPrivate`, so
   * it is structurally outside every scored payload rather than filtered out
   * by a route that could forget.
   */
  accessRequirementsPrompt: string;
  criteria: AdmissionCriterion[];
  scoreScale: AdmissionScoreScale;
  /** How many reviewers each application wants before it is "covered". */
  reviewersPerApplication: number;
  /** Who may review. Membership of this array IS the review permission. */
  reviewerUids: string[];
  /** Sees aggregates with names, and presses decide. Never blind. */
  finalDeciderUid: string | null;
  blind: AdmissionBlindSettings;
  /** Runs whose attendance and submission rollups feed the evidence snapshot. */
  evidenceRunIds: string[];
  reminderOffsets: ReminderOffset[];
  /** Runs this round may place people onto. Empty for an appointment round. */
  outcomeRunIds: string[];
  applicationCounts: AdmissionApplicationCounts;
  archived: boolean;
  /** Set by the clone route. Null for a round authored from scratch. */
  clonedFromRoundId: string | null;
  authorUid: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

/**
 * `admissionRounds/{roundId}/stages/{stageId}` — one released-on-a-date block
 * of questions.
 *
 * Subcollections do NOT inherit their parent's rules, so this needs its own
 * explicit `allow read, write: if false` match block. Without one it falls to
 * deny-by-default today and would silently open the day someone adds a
 * wildcard above it, which is the whole reason the block is written out.
 */
export type AdmissionStageDoc = {
  /** "s1", "s2", ... assigned by the authoring route in `round.stageIds` order. */
  id: string;
  roundId: string;
  label: string;
  /** Plain-text preamble shown above the questions. Member-facing copy. */
  intro: string;
  /**
   * THE thing that must never reach a client before its release instant. See
   * `src/lib/admissions/stageRelease.ts`; the route serialising a stage is
   * what enforces it, and the emulator suite asserts no client-readable
   * document anywhere carries a `questions` key.
   */
  questions: FormQuestion[];
  /** Civil date key, Europe/London. Null = releases with the round. */
  releaseAt: string | null;
  /** Wall clock on `releaseAt`, 24-hour "HH:MM". */
  releaseTimeLocal: string;
  /** Stamped by the manual release route. Only ever brings a release forward. */
  manualReleasedAt: Date | null;
  /** Stage deadline. Null = the round's own. Never later than it. */
  closesAt: Date | null;
  /** Freeze this stage's answers on submit, even while the round stays open. */
  locksOnSubmit: boolean;
  /** Position in `round.stageIds`, denormalised for a standalone read. */
  order: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A round's doc id: `slugId(label)`, e.g. `autumn-2026-intake__k3f9a2b1`.
 *
 * NEVER derived from a run id. One round feeds several runs and an
 * appointment round feeds none, so a run-derived id would be a lie in both
 * directions. CONSTRUCT-ONLY, like every other slug id here: the label is
 * stored as a field and the id is never parsed back apart.
 */
export function admissionRoundId(label: string): string {
  return slugId(label);
}

/**
 * A stage's doc id from its position: `s1`, `s2`, ... Deterministic so the
 * authoring route can address a stage by index without a lookup, and short so
 * the marker ids that name it (`stagerel__{roundId}__{stageId}`) stay
 * readable.
 */
export function admissionStageId(order: number): string {
  return `s${Math.max(1, Math.floor(order) + 1)}`;
}

// ---------------------------------------------------------------------------
// Normalisers
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

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asUidList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const u of v) {
    if (typeof u === "string" && u) seen.add(u);
    if (seen.size >= cap) break;
  }
  return Array.from(seen);
}

function asIdList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, cap);
}

function asProgrammeOptions(v: unknown): ProgrammeOption[] {
  if (!Array.isArray(v)) return [];
  const L = ADMISSION_ROUND_FIELD_LIMITS;
  const out: ProgrammeOption[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Raw;
    const id = str(o.id, 60);
    if (!id) continue;
    out.push({ id, label: str(o.label, L.programmeOptionLabel) });
    if (out.length >= L.maxProgrammeOptions) break;
  }
  return out;
}

function asProgrammePreference(v: unknown): RoundProgrammePreference {
  const raw = (v ?? {}) as Raw;
  return {
    enabled: bool(raw.enabled),
    streams: asProgrammeOptions(raw.streams),
    fellowships: asProgrammeOptions(raw.fellowships),
    maxRankedFellowships: Math.max(
      1,
      Math.min(
        ADMISSION_ROUND_FIELD_LIMITS.maxProgrammeOptions,
        int(raw.maxRankedFellowships, EMPTY_PROGRAMME_PREFERENCE.maxRankedFellowships),
      ),
    ),
    offerFellowshipFallback: bool(raw.offerFellowshipFallback),
  };
}

function asCriteria(v: unknown): AdmissionCriterion[] {
  if (!Array.isArray(v)) return [];
  const L = ADMISSION_ROUND_FIELD_LIMITS;
  const out: AdmissionCriterion[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Raw;
    const id = str(c.id, 60);
    if (!id) continue;
    out.push({
      id,
      label: str(c.label, L.criterionLabel),
      guidance: str(c.guidance, L.criterionGuidance),
    });
    if (out.length >= L.maxCriteria) break;
  }
  return out;
}

function asScoreScale(v: unknown): AdmissionScoreScale {
  const raw = (v ?? {}) as Raw;
  const L = ADMISSION_ROUND_FIELD_LIMITS;
  const min = Math.max(L.minScore, Math.min(L.maxScore, int(raw.min, DEFAULT_SCORE_SCALE.min)));
  const max = Math.max(L.minScore, Math.min(L.maxScore, int(raw.max, DEFAULT_SCORE_SCALE.max)));
  // A backwards or degenerate scale would let every score be "out of range",
  // so it falls back whole rather than being repaired end by end.
  return max > min ? { min, max } : { ...DEFAULT_SCORE_SCALE };
}

function asReminderOffsets(v: unknown): ReminderOffset[] {
  if (!Array.isArray(v)) return [];
  const out: ReminderOffset[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Raw;
    const id = o.id as ReminderOffsetId;
    if (!REMINDER_OFFSET_IDS.includes(id) || seen.has(id)) continue;
    const atLocalTime = str(o.atLocalTime, 5);
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(atLocalTime)) continue;
    seen.add(id);
    out.push({ id, daysBefore: Math.max(0, int(o.daysBefore, 0)), atLocalTime });
    if (out.length >= ADMISSION_ROUND_FIELD_LIMITS.maxReminderOffsets) break;
  }
  return out;
}

function asApplicationCounts(v: unknown): AdmissionApplicationCounts {
  const raw = (v ?? {}) as Raw;
  const counts = zeroApplicationCounts();
  for (const status of ADMISSION_APPLICATION_STATUSES) {
    counts[status] = Math.max(0, int(raw[status], 0));
  }
  return counts;
}

/** Civil date key or null. Rejects a stored instant, which is not this field. */
function asDateKey(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export function normalizeAdmissionRound(id: string, data: Raw): AdmissionRoundDoc {
  const L = ADMISSION_ROUND_FIELD_LIMITS;
  const kind = data.kind as AdmissionRoundKind;
  const status = data.status as AdmissionRoundStatus;
  return {
    id,
    kind: ADMISSION_ROUND_KINDS.includes(kind) ? kind : "enrolment",
    label: str(data.label, L.label),
    slug: str(data.slug, L.slug),
    blurb: str(data.blurb, L.blurb),
    academicYear: str(data.academicYear, L.academicYear),
    status: ADMISSION_ROUND_STATUSES.includes(status) ? status : "draft",
    opensAt: tsToDate(data.opensAt),
    closesAt: tsToDate(data.closesAt),
    decisionsByDate: asDateKey(data.decisionsByDate),
    stageIds: asIdList(data.stageIds, L.maxStages),
    programmePreference: asProgrammePreference(data.programmePreference),
    availabilityGrid: normalizeAvailabilityGrid(data.availabilityGrid),
    accessRequirementsPrompt: str(
      data.accessRequirementsPrompt,
      L.accessRequirementsPrompt,
    ),
    criteria: asCriteria(data.criteria),
    scoreScale: asScoreScale(data.scoreScale),
    reviewersPerApplication: Math.max(1, int(data.reviewersPerApplication, 2)),
    reviewerUids: asUidList(data.reviewerUids, L.maxReviewers),
    finalDeciderUid: str(data.finalDeciderUid) || null,
    blind: {
      hideNames: bool(
        (data.blind as Raw | undefined)?.hideNames,
        DEFAULT_BLIND_SETTINGS.hideNames,
      ),
      hideMembership: bool(
        (data.blind as Raw | undefined)?.hideMembership,
        DEFAULT_BLIND_SETTINGS.hideMembership,
      ),
    },
    evidenceRunIds: asIdList(data.evidenceRunIds, L.maxEvidenceRuns),
    reminderOffsets: asReminderOffsets(data.reminderOffsets),
    outcomeRunIds: asIdList(data.outcomeRunIds, L.maxOutcomeRuns),
    applicationCounts: asApplicationCounts(data.applicationCounts),
    archived: bool(data.archived),
    clonedFromRoundId: str(data.clonedFromRoundId) || null,
    authorUid: str(data.authorUid),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}

export function normalizeAdmissionStage(id: string, data: Raw): AdmissionStageDoc {
  const L = ADMISSION_ROUND_FIELD_LIMITS;
  return {
    id,
    roundId: str(data.roundId),
    label: str(data.label, L.stageLabel),
    intro: str(data.intro, L.stageIntro),
    // Reuse the events form machinery end to end: the same `FormQuestion[]`,
    // the same shape filter, and the same `validateAnswers` on the way back
    // in. `sanitizeSignupForm` REBUILDS each row and drops unknown keys, so a
    // new question field has to be added there to persist at all.
    questions: sanitizeSignupForm(data.questions).slice(0, L.maxStageQuestions),
    releaseAt: asDateKey(data.releaseAt),
    releaseTimeLocal: /^([01]\d|2[0-3]):([0-5]\d)$/.test(str(data.releaseTimeLocal))
      ? str(data.releaseTimeLocal, 5)
      : "09:00",
    manualReleasedAt: tsToDate(data.manualReleasedAt),
    closesAt: tsToDate(data.closesAt),
    locksOnSubmit: bool(data.locksOnSubmit),
    order: Math.max(0, int(data.order, 0)),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}
