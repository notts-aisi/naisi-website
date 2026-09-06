/**
 * `circulations/{circulationId}` and its two subcollections: one act of
 * sending a worksheet to people. See `docs/worksheets.md` for the contract.
 *
 * Three shapes, and the split between them is the whole access model:
 *
 *  - the CIRCULATION carries the semi-frozen copy of the questions, who is
 *    staff, and the counters. Its `staffUids` array is the single thing every
 *    rule and every staff list query keys off, because a rule cannot join.
 *  - a RESPONSE (`responses/{uid}`) is one recipient's answers. Its doc id IS
 *    the recipient's uid, so "may I read this" is `uid == request.auth.uid`
 *    with no lookup, and "prove you are a recipient" is one `exists()` on the
 *    circulation's read rule.
 *  - a REVIEW (`reviews/{uid}`) is the staff-only notes and SCORES about that
 *    response. It is a separate document rather than a field on the response
 *    precisely so that "the recipient reads their own response" and "scores
 *    are never seen by the recipient" are the same rule rather than two rules
 *    that have to agree. Returning feedback COPIES the parts the toggles allow
 *    onto the response; scores are never copied.
 *
 * Runtime dependency runs one way only: this module imports `sanitizeItems`
 * from `worksheets.ts`, and `worksheets.ts` imports only the `ReviewConfig`
 * TYPE back (erased at compile time). See the comment at the top of that file.
 */
import { sanitizeItems, type WorksheetAnswer, type WorksheetItem } from "./worksheets";
import type { TaskStatus } from "./tasks";

export const CIRCULATIONS_COLLECTION = "circulations";
export const RESPONSES_SUBCOLLECTION = "responses";
export const REVIEWS_SUBCOLLECTION = "reviews";

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** A closed circulation takes no further submissions and archives its tasks. */
export type CirculationStatus = "open" | "closed";

export type ResponseState = "not-opened" | "started" | "submitted" | "reviewed";

export const RESPONSE_STATES: ResponseState[] = [
  "not-opened",
  "started",
  "submitted",
  "reviewed",
];

export const RESPONSE_STATE_LABELS: Record<ResponseState, string> = {
  "not-opened": "Not opened",
  started: "In progress",
  submitted: "Submitted",
  reviewed: "Reviewed",
};

/**
 * Submitted and reviewed are FROZEN: `firestore.rules` refuses the recipient's
 * writes unless the STORED state is not-opened or started, and unfreeze is an
 * admin route. Anything reading "can this person still type" asks here rather
 * than listing the two states again, so widening the band is one edit.
 */
export function isTerminalResponseState(state: ResponseState): boolean {
  return state === "submitted" || state === "reviewed";
}

// ---------------------------------------------------------------------------
// Review configuration
// ---------------------------------------------------------------------------

/**
 * Four independent toggles, defaulted from the worksheet and settable per
 * circulation. They are independent rather than a mode because every
 * combination is a real one somebody asked for: notes with no marks, marks
 * with no notes, and a worksheet returned or kept internal.
 */
export type ReviewConfig = {
  perQuestionFeedback: boolean;
  perQuestionScoring: boolean;
  overallFeedback: boolean;
  returnToRecipient: boolean;
};

/**
 * The defaults, written down once. Feedback on and scoring off is the honest
 * default for a committee worksheet: a score the recipient never sees is a
 * thing staff have to explain, and most circulations are not graded.
 */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  perQuestionFeedback: true,
  perQuestionScoring: false,
  overallFeedback: true,
  returnToRecipient: true,
};

export function normalizeReviewConfig(raw: unknown): ReviewConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_REVIEW_CONFIG };
  const r = raw as Record<string, unknown>;
  const read = (key: keyof ReviewConfig) =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : DEFAULT_REVIEW_CONFIG[key];
  return {
    perQuestionFeedback: read("perQuestionFeedback"),
    perQuestionScoring: read("perQuestionScoring"),
    overallFeedback: read("overallFeedback"),
    returnToRecipient: read("returnToRecipient"),
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationEvent =
  | "assigned"
  | "dueSoon"
  | "submitted"
  | "feedbackReturned"
  | "copyEdited";

export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  "assigned",
  "dueSoon",
  "submitted",
  "feedbackReturned",
  "copyEdited",
];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  assigned: "Sent to someone",
  dueSoon: "Due soon",
  submitted: "Someone submits",
  feedbackReturned: "Feedback returned",
  copyEdited: "Questions edited",
};

/**
 * One plain sentence each, shown under the switch on the circulation page.
 * They say WHO gets the message, because that is the thing the sender is
 * actually deciding and the thing a label has no room for.
 */
export const NOTIFICATION_EVENT_DESCRIPTIONS: Record<NotificationEvent, string> = {
  assigned: "Tell people you have sent this to them.",
  dueSoon: "Remind anyone who has not submitted, shortly before the due date.",
  submitted: "Tell the reviewers when someone submits their answers.",
  feedbackReturned: "Tell someone when you return their feedback.",
  copyEdited: "Tell people who have started, but not submitted, when you change the questions.",
};

export type NotificationToggle = { email: boolean; push: boolean };

export type NotificationToggles = Record<NotificationEvent, NotificationToggle>;

/**
 * Defaults chosen by how interruptive each message is against how much the
 * recipient needs it now.
 *
 * `dueSoon` has push off because a reminder is not urgent by definition: it is
 * the message that arrives while somebody is asleep. `copyEdited` is off
 * entirely because a sender fixing a typo should not have to remember to
 * silence a broadcast first; it is the one switch you turn ON, for the edit
 * that actually changes what was asked.
 */
export const DEFAULT_NOTIFICATIONS: NotificationToggles = {
  assigned: { email: true, push: true },
  dueSoon: { email: true, push: false },
  submitted: { email: true, push: true },
  feedbackReturned: { email: true, push: true },
  copyEdited: { email: false, push: false },
};

export function normalizeNotifications(raw: unknown): NotificationToggles {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as NotificationToggles;
  for (const event of NOTIFICATION_EVENTS) {
    const entry = source[event];
    const fallback = DEFAULT_NOTIFICATIONS[event];
    if (!entry || typeof entry !== "object") {
      out[event] = { ...fallback };
      continue;
    }
    const e = entry as Record<string, unknown>;
    out[event] = {
      email: typeof e.email === "boolean" ? e.email : fallback.email,
      push: typeof e.push === "boolean" ? e.push : fallback.push,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Budgets the routes enforce. `maxRecipientsPerRequest` is the one with teeth:
 * every recipient costs a response document, a task and an email, so an
 * unbounded list is an unbounded send. Adding a hundred and one people is two
 * requests, which is a cost the UI can carry.
 */
export const CIRCULATION_LIMITS = {
  maxRecipientsPerRequest: 100,
  maxReviewers: 5,
  /**
   * Per-question feedback, one box per question. NOT mirrored in
   * firestore.rules and cannot be: `perQuestion` is a map and rules cannot
   * walk a map's values, so the rule caps the NUMBER of entries and this
   * number is enforced by the editor and by the return route. Same for the
   * score band below.
   */
  feedback: 2000,
  /**
   * The single overall-feedback box. Mirrored by
   * `get('overall', '').size() <= 4000` in firestore.rules, and asserted
   * against the text of that file in tests/worksheets-model.test.mjs so the
   * two cannot drift into a save the editor allows and the rules refuse.
   */
  overall: 4000,
  scoreMin: 0,
  scoreMax: 100,
} as const;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Where a circulation came from. A discriminated union with one member today,
 * because the second one is already known: a course exercise would arrive as
 * `{ kind: "course-exercise", runId, weekId }` and nothing else in the model
 * would move. A bare string would have had to be widened instead.
 */
export type CirculationSource = { kind: "worksheet" };

export type CirculationDoc = {
  id: string;
  worksheetId: string;
  title: string;
  description: string;
  /**
   * The circulation's OWN copy of the questions, taken at send time. Editing
   * the library worksheet afterwards changes nothing here, which is what makes
   * a sent worksheet answerable at all.
   */
  items: WorksheetItem[];
  senderUid: string;
  /** The library worksheet's author, staff by virtue of having written it. */
  authorUid: string;
  reviewerUids: string[];
  /**
   * Sender, author, reviewers, de-duplicated. Written by the routes only.
   * Every staff rule and every staff list query keys off this ONE array,
   * because Firestore rules cannot join and a list query cannot be
   * "array-contains one of three fields".
   */
  staffUids: string[];
  reviewConfig: ReviewConfig;
  notifications: NotificationToggles;
  dueDate: Date | null;
  status: CirculationStatus;
  /**
   * Asserted, never branched on, in v1. It exists so an anonymous mode can be
   * added later without a migration: responses would stay keyed by uid for the
   * rules, with a server-only pseudonym map beside them.
   */
  anonymity: "named";
  source: CirculationSource;
  recipientCount: number;
  submittedCount: number;
  reviewedCount: number;
  /** Stamped when staff edit the copy mid-flight; drives the copyEdited mail. */
  itemsEditedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  closedAt: Date | null;
};

/**
 * What the recipient's client stamps as they work. Deliberately coarse: no
 * keystrokes, no paste events, no per-question timing. It answers "did this
 * land, and did anyone start it", which is what a sender chasing a deadline
 * needs, and it is shown to the recipient too rather than kept from them.
 */
export type ResponseActivity = {
  firstOpenedAt: Date | null;
  pageOpens: number;
  activeMs: number;
  lastActiveAt: Date | null;
};

export type ResponseProgress = {
  answered: number;
  total: number;
  requiredAnswered: number;
  required: number;
};

/**
 * The staff feedback that was RETURNED to the recipient, copied onto the
 * response by the return route. Scores are absent by construction: this type
 * has nowhere to put one, so a change that started copying them would not
 * typecheck.
 */
export type ReturnedFeedback = {
  perQuestion: Record<string, { feedback: string }>;
  overall: string;
  returnedAt: Date | null;
  returnedByUid: string;
};

export type ResponseDoc = {
  /** Doc id, which IS the recipient's uid. */
  id: string;
  uid: string;
  circulationId: string;
  /** The recipient's task. Nullable: a course adoption may not mint one. */
  taskId: string | null;
  state: ResponseState;
  answers: Record<string, WorksheetAnswer>;
  progress: ResponseProgress;
  activity: ResponseActivity;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  returned: ReturnedFeedback | null;
  unfrozenAt: Date | null;
  unfrozenByUid: string | null;
  addedAt: Date | null;
  addedByUid: string;
  updatedAt: Date | null;
};

/** One question's staff notes. `score` is staff-only and never returned. */
export type ReviewEntry = { feedback?: string; score?: number };

export type ReviewDoc = {
  /** Doc id, which IS the reviewed recipient's uid. */
  id: string;
  perQuestion: Record<string, ReviewEntry>;
  overall: string;
  updatedAt: Date | null;
  updatedByUid: string;
};

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * The staff list, de-duplicated, in a stable order (sender, author, then the
 * reviewers as named).
 *
 * One function because it is written at create, rewritten when reviewers
 * change, and compared against on every rule. Building it twice is how the
 * sender ends up unable to read the thing they sent.
 */
export function circulationStaffUids(input: {
  senderUid: string;
  authorUid: string;
  reviewerUids: string[];
}): string[] {
  const out: string[] = [];
  for (const uid of [input.senderUid, input.authorUid, ...(input.reviewerUids ?? [])]) {
    if (typeof uid !== "string" || !uid) continue;
    if (out.includes(uid)) continue;
    out.push(uid);
  }
  return out;
}

/**
 * The task status one response state implies, per the table in
 * `docs/worksheets.md`.
 *
 * `submitted` is the only branch that reads the config: with
 * `returnToRecipient` on there is still work for staff to do, so the task sits
 * in Review; with it off the worksheet is finished the moment it arrives and
 * leaving the task open would be a queue nobody ever empties.
 *
 * Every writer of a worksheet task's status goes through here (the submit
 * route, the return route and the unfreeze route), so the board can never
 * disagree with the response it mirrors.
 */
export function taskStatusForResponse(
  state: ResponseState,
  reviewConfig: ReviewConfig,
): TaskStatus {
  switch (state) {
    case "not-opened":
      return "todo";
    case "started":
      return "in-progress";
    case "submitted":
      return reviewConfig.returnToRecipient ? "review" : "done";
    case "reviewed":
      return "done";
  }
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function normalizeCirculation(id: string, data: Raw): CirculationDoc {
  return {
    id,
    worksheetId: str(data.worksheetId),
    title: str(data.title),
    description: str(data.description),
    items: sanitizeItems(data.items),
    senderUid: str(data.senderUid),
    authorUid: str(data.authorUid),
    reviewerUids: stringArray(data.reviewerUids),
    staffUids: stringArray(data.staffUids),
    reviewConfig: normalizeReviewConfig(data.reviewConfig),
    notifications: normalizeNotifications(data.notifications),
    dueDate: tsToDate(data.dueDate),
    // Defaults OPEN rather than closed: a document missing the field is one
    // written before the field existed, and reading it as closed would silently
    // refuse submissions on a circulation the sender believes is live.
    status: data.status === "closed" ? "closed" : "open",
    anonymity: "named",
    source: { kind: "worksheet" },
    recipientCount: num(data.recipientCount),
    submittedCount: num(data.submittedCount),
    reviewedCount: num(data.reviewedCount),
    itemsEditedAt: tsToDate(data.itemsEditedAt),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
    closedAt: tsToDate(data.closedAt),
  };
}

function normalizeProgress(raw: unknown): ResponseProgress {
  const r = raw && typeof raw === "object" ? (raw as Raw) : {};
  return {
    answered: num(r.answered),
    total: num(r.total),
    requiredAnswered: num(r.requiredAnswered),
    required: num(r.required),
  };
}

function normalizeActivity(raw: unknown): ResponseActivity {
  const r = raw && typeof raw === "object" ? (raw as Raw) : {};
  return {
    firstOpenedAt: tsToDate(r.firstOpenedAt),
    pageOpens: num(r.pageOpens),
    activeMs: num(r.activeMs),
    lastActiveAt: tsToDate(r.lastActiveAt),
  };
}

/**
 * Answers are stored as the recipient's client wrote them, so they are shaped
 * here rather than trusted: a key whose value is not an object with a known
 * `type` is dropped. Per-answer RANGE checking is `validateAnswer`'s job,
 * against the question, which this function does not have.
 */
function normalizeAnswers(raw: unknown): Record<string, WorksheetAnswer> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, WorksheetAnswer> = {};
  for (const [questionId, value] of Object.entries(raw as Raw)) {
    if (!value || typeof value !== "object") continue;
    const answer = value as Raw;
    switch (answer.type) {
      case "text":
        if (typeof answer.text === "string") out[questionId] = { type: "text", text: answer.text };
        break;
      case "choice":
        if (typeof answer.optionId === "string") {
          out[questionId] = { type: "choice", optionId: answer.optionId };
        }
        break;
      case "choices":
        if (Array.isArray(answer.optionIds)) {
          out[questionId] = { type: "choices", optionIds: stringArray(answer.optionIds) };
        }
        break;
      case "rating":
        if (typeof answer.value === "number") {
          out[questionId] = { type: "rating", value: answer.value };
        }
        break;
      case "images":
        if (Array.isArray(answer.images)) {
          out[questionId] = {
            type: "images",
            images: answer.images
              .filter(
                (img: unknown): img is { url: string; storagePath: string } =>
                  !!img &&
                  typeof img === "object" &&
                  typeof (img as Raw).url === "string" &&
                  typeof (img as Raw).storagePath === "string",
              )
              .map((img) => ({ url: img.url, storagePath: img.storagePath })),
          };
        }
        break;
      default:
        break;
    }
  }
  return out;
}

function normalizeReturned(raw: unknown): ReturnedFeedback | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Raw;
  const perQuestion: Record<string, { feedback: string }> = {};
  if (r.perQuestion && typeof r.perQuestion === "object") {
    for (const [questionId, value] of Object.entries(r.perQuestion as Raw)) {
      if (!value || typeof value !== "object") continue;
      const feedback = (value as Raw).feedback;
      if (typeof feedback === "string" && feedback) perQuestion[questionId] = { feedback };
    }
  }
  return {
    perQuestion,
    overall: str(r.overall),
    returnedAt: tsToDate(r.returnedAt),
    returnedByUid: str(r.returnedByUid),
  };
}

export function normalizeResponse(id: string, data: Raw): ResponseDoc {
  const state = data.state as ResponseState;
  return {
    id,
    // The doc id IS the recipient's uid, so it is the authority when the
    // stored field disagrees. A response whose `uid` field had drifted would
    // otherwise be read under one identity and written under another.
    uid: id,
    circulationId: str(data.circulationId),
    taskId: typeof data.taskId === "string" && data.taskId ? data.taskId : null,
    state: RESPONSE_STATES.includes(state) ? state : "not-opened",
    answers: normalizeAnswers(data.answers),
    progress: normalizeProgress(data.progress),
    activity: normalizeActivity(data.activity),
    submittedAt: tsToDate(data.submittedAt),
    reviewedAt: tsToDate(data.reviewedAt),
    returned: normalizeReturned(data.returned),
    unfrozenAt: tsToDate(data.unfrozenAt),
    unfrozenByUid:
      typeof data.unfrozenByUid === "string" && data.unfrozenByUid ? data.unfrozenByUid : null,
    addedAt: tsToDate(data.addedAt),
    addedByUid: str(data.addedByUid),
    updatedAt: tsToDate(data.updatedAt),
  };
}

export function normalizeReview(id: string, data: Raw): ReviewDoc {
  const perQuestion: Record<string, ReviewEntry> = {};
  if (data.perQuestion && typeof data.perQuestion === "object") {
    for (const [questionId, value] of Object.entries(data.perQuestion as Raw)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Raw;
      const out: ReviewEntry = {};
      if (typeof entry.feedback === "string" && entry.feedback) out.feedback = entry.feedback;
      if (typeof entry.score === "number" && Number.isFinite(entry.score)) out.score = entry.score;
      // An entry with neither half is a leftover from a cleared box; keeping it
      // would make "has this question been reviewed" false-positive.
      if (out.feedback !== undefined || out.score !== undefined) perQuestion[questionId] = out;
    }
  }
  return {
    id,
    perQuestion,
    overall: str(data.overall),
    updatedAt: tsToDate(data.updatedAt),
    updatedByUid: str(data.updatedByUid),
  };
}
