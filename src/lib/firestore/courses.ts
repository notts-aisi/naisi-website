import {
  sanitizeBlocks,
  youtubeIdFromUrl,
  type Block,
} from "./newsletterBlocks";
import { sanitizeSignupForm, type FormQuestion } from "./events";
import { isValidDateKey, type WeekPlanEntry } from "../courses/weekPlan";

/**
 * Courses data model — `courses/{id}` → `courseRuns/{id}` (top-level) →
 * `courseRuns/{runId}/weeks/{wNN}`. A course is the evergreen curriculum
 * shell; a run is one delivery of it (e.g. "Autumn 2026") carrying the
 * cohort's dates, application form, and server-owned role arrays; weeks hold
 * the authored content.
 *
 * Curriculum content (guideBlocks, materials, exercises, checklist) is
 * TRUSTED — authored by `draftCourse` permission holders, same trust model as
 * newsletter/event blocks. Member-authored content NEVER lives here and is
 * never `Block[]`: it is typed `string` everywhere (see courseProgress /
 * courseExercises) and rendered as text nodes only, which is the XSS boundary.
 */

// Re-exported so consumers of the courses data model get the week-plan entry
// type from one place. The shape itself lives in `../courses/weekPlan` next to
// the week maths that interprets it.
export type { WeekPlanEntry } from "../courses/weekPlan";

// ---- Course ----

export type CourseTrack = "technical" | "governance" | "general";

export const COURSE_TRACKS: CourseTrack[] = ["technical", "governance", "general"];

export const COURSE_TRACK_LABELS: Record<CourseTrack, string> = {
  technical: "Technical",
  governance: "Governance",
  general: "General",
};

export type CourseStatus = "draft" | "published" | "archived";

export const COURSE_STATUSES: CourseStatus[] = ["draft", "published", "archived"];

export const COURSE_STATUS_LABEL: Record<CourseStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

export type CourseDoc = {
  /** Firestore doc id: `slugId(title)`. */
  id: string;
  title: string;
  /** One-line hook shown on the catalogue card. */
  tagline: string;
  /** Public course intro. Trusted authored content (see module comment). */
  summaryBlocks: Block[];
  track: CourseTrack;
  /** Free-text difficulty line, e.g. "No prior experience needed". */
  level: string;
  /** Rough weekly commitment shown on the catalogue, e.g. 5. */
  estimatedWeeklyHours: number | null;
  status: CourseStatus;
  /**
   * The run whose curriculum the PUBLIC course pages display. Set by admins
   * when a run's content is ready to be the shop window; null falls back to
   * "no curriculum preview yet".
   */
  showcaseRunId: string | null;
  authorUid: string;
  /**
   * Members granted edit access to this specific course without holding the
   * global draft permission (events `collaboratorUids` pattern). Server-owned:
   * pinned in rules, mutated only via routes.
   */
  collaboratorUids: string[];
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

// ---- Course run ----

export type CourseRunStatus =
  | "draft"
  | "applications-open"
  | "applications-closed"
  | "running"
  | "completed"
  | "cancelled";

export const COURSE_RUN_STATUSES: CourseRunStatus[] = [
  "draft",
  "applications-open",
  "applications-closed",
  "running",
  "completed",
  "cancelled",
];

export const COURSE_RUN_STATUS_LABEL: Record<CourseRunStatus, string> = {
  draft: "Draft",
  "applications-open": "Applications open",
  "applications-closed": "Applications closed",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * How people get onto a run.
 *
 * `admissions` is the historical shape: apply, be reviewed, be allocated.
 * `open` is the pre-course / bootcamp shape from the V3 decisions, where
 * everyone who signs up gets a place and there is no application at all.
 *
 * SERVER-OWNED and birth-pinned to `admissions`, because it opens a WRITE
 * DOOR: an open-mode run admits an enrolment with no application behind it.
 * That puts it in the same tier as the role arrays and the counters, not in
 * the drafter's content band, and
 * `PATCH /api/courses/runs/[runId]/enrol-mode` is its only writer.
 */
export type CourseEnrolMode = "admissions" | "open";

export const COURSE_ENROL_MODES: CourseEnrolMode[] = ["admissions", "open"];

export const COURSE_ENROL_MODE_LABEL: Record<CourseEnrolMode, string> = {
  admissions: "Applications and review",
  open: "Open enrolment",
};

/**
 * One stream inside a run (e.g. technical / governance / generalist on the
 * research incubator). A week's materials, exercises and checklist items may
 * each be scoped to a subset of these through `streamIds`; an item with none
 * is CORE and shown to everybody.
 *
 * SERVER-OWNED, birth-pinned empty, pinned on update, for the same reason
 * `enrolMode` is: the enrol route validates a member's requested stream
 * against this list, and `courseEnrolments.streamId` is `allow write: if
 * false`. A client-direct edit here could therefore invalidate rows in a
 * collection the client cannot write, which is the definition of a field that
 * does not belong in the content band.
 */
export type CourseRunStream = {
  /** Short slug, stable for the life of the run — item `streamIds` name it. */
  id: string;
  label: string;
};

/**
 * The one exercise a member must complete to clear the run's submission bar
 * (the pre-course's "6 sessions, attend 4 in full, plus the submission").
 *
 * STORED ABSENT WHEN UNSET, NEVER NULL. `firestore.rules` pins this field
 * with `.get('submissionExerciseRef', {})` on BOTH sides, and a stored null
 * compares unequal to that default, which would wedge every later non-admin
 * edit of the run — the exact trap already recorded for `templateId` at
 * courses.ts:729 and in the rules block itself. The normaliser therefore
 * omits the key rather than returning null, so a doc round-tripped through it
 * can never reintroduce one.
 */
export type SubmissionExerciseRef = {
  /** Week doc id, "w01".."w60". */
  weekId: string;
  exerciseId: string;
};

/**
 * Per-status application counters, maintained transactionally by the apply /
 * decide routes. Server-owned: rules pin the whole map against client writes.
 */
export type ApplicationCounts = {
  pending: number;
  accepted: number;
  rejected: number;
  waitlisted: number;
  withdrawn: number;
};

export const EMPTY_APPLICATION_COUNTS: ApplicationCounts = {
  pending: 0,
  accepted: 0,
  rejected: 0,
  waitlisted: 0,
  withdrawn: 0,
};

export type CourseRunDoc = {
  /** Firestore doc id: `slugId(courseTitle + label)`. */
  id: string;
  courseId: string;
  /** Denormalised course title so run lists render without a second read. */
  courseTitle: string;
  /** Human run label, e.g. "Autumn 2026". */
  label: string;
  /** Academic year tag, e.g. "2026/27" — matches `users.paidMembershipYears`. */
  academicYear: string;
  status: CourseRunStatus;
  /**
   * Server-owned (see `CourseEnrolMode`). Absent on every run written before
   * V3, which normalises to "admissions" — the behaviour those runs already
   * had.
   */
  enrolMode: CourseEnrolMode;
  /** Server-owned (see `CourseRunStream`). Empty = a run with no streams. */
  streams: CourseRunStream[];
  /**
   * Server-owned counter: how many enrolments this run currently holds. Moved
   * only by the transactions that write `courseEnrolments`, so it can never
   * drift from the rows it summarises — the `groupCount` / `memberCount`
   * precedent. Read by the open-enrol picker and by the enrol-mode route,
   * which refuses to change the mode once anybody is on the run.
   */
  enrolledCount: number;
  /**
   * The run's submission bar, or ABSENT when it has none. Never null on the
   * wire — see `SubmissionExerciseRef`.
   */
  submissionExerciseRef?: SubmissionExerciseRef;
  /**
   * CIVIL date string "YYYY-MM-DD" (Europe/London), NOT a timestamp — week
   * maths runs on civil dates so DST transitions can't shift week boundaries.
   * Interpreted exclusively by `../courses/weekPlan`.
   */
  startDate: string;
  /** Ordered teaching weeks + breaks. Interpreted by `currentWeekFor()`. */
  weekPlan: WeekPlanEntry[];
  /** Application form — reuses the events form machinery verbatim. */
  applicationForm: FormQuestion[];
  /** Applications window. Null = no automatic bound on that side. */
  applicationsOpenAt: Date | null;
  applicationsCloseAt: Date | null;
  /** Soft cap on accepted applicants; null = uncapped. */
  applicationCap: number | null;
  /**
   * Server-owned role arrays (routes only; pinned in rules). Admissions is
   * deliberately a DIFFERENT array from facilitation — reviewing applicants
   * grants no access to the cohort, and vice versa.
   */
  admissionsReviewerUids: string[];
  runFacilitatorUids: string[];
  trackLeadUids: string[];
  /** Server-owned counters (see ApplicationCounts). */
  applicationCounts: ApplicationCounts;
  groupCount: number;
  /** Subscription channel for cohort email, always `cohort:<runId>`. */
  channel: string;
  /**
   * Soft archive — the everyday half of the v2-1 deletion protocol, mirroring
   * `courseGroups.archived` and deliberately ORTHOGONAL to `status` (a
   * completed run and a cancelled run can both be archived; adding an
   * "archived" status member would have collided with the lifecycle table in
   * the status route). Archived runs drop out of the admin default list, the
   * public catalogue, /me live sections and application windows; member
   * history keeps reading. The destroy cascade also sets it in its opening
   * write, so a run mid-destroy is already off every discovery surface.
   */
  archived: boolean;
  /**
   * TEMPLATE PROVENANCE (v2 decision 3). The `courseTemplates` snapshot this
   * run's weeks were last applied from, and the label that snapshot carried at
   * the time. Null on a run authored from scratch or copied run-to-run.
   *
   * Server-owned, pinned in rules: only
   * `POST /api/courses/runs/[runId]/apply-template` (Admin SDK) writes them.
   * Provenance that the people who edit the curriculum can also edit is not
   * provenance — a run could claim to be teaching "Autumn 2026 final" while
   * carrying something else, and the snapshot is the only record of what a
   * cohort was actually given.
   *
   * `templateLabel` is a POINT-IN-TIME copy, deliberately not resolved through
   * `templateId` at read time: the snapshot doc can be relabelled or deleted,
   * and "which version did this cohort get" must survive both.
   */
  templateId: string | null;
  templateLabel: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

/**
 * The subscription channel for a run's cohort email. Deterministic from the
 * run id so the send routes, the subscribe-on-allocation step, and the stored
 * `channel` field can never disagree.
 */
export function courseRunChannel(runId: string): string {
  return `cohort:${runId}`;
}

// ---- Week ----

/**
 * Week doc id: "w01".."w60". Zero-padded so Firestore's lexicographic doc
 * ordering matches week order, and STABLE across copy-forward (clone-weeks
 * preserves ids so progress/exercise references survive re-runs).
 */
export function weekDocId(weekNumber: number): string {
  return `w${String(weekNumber).padStart(2, "0")}`;
}

export type CourseWeekDoc = {
  /** Firestore doc id: `weekDocId(weekNumber)`. */
  id: string;
  weekNumber: number;
  title: string;
  /**
   * Plain-text week summary. Doubles as the mirrored My Work task's
   * description, so it stays plain text — never blocks.
   */
  summary: string;
  /** The week's guide prose. Trusted authored content (see module comment). */
  guideBlocks: Block[];
  materials: Material[];
  exercises: Exercise[];
  checklist: ChecklistItem[];
  /** Rough total for the week's materials, shown in the week header. */
  estimatedMinutes: number | null;
  /** Unpublished weeks are hidden from learners and the public curriculum. */
  published: boolean;
  updatedAt?: Date | null;
  updatedByUid?: string | null;
};

// ---- Materials ----

export type MaterialType = "video" | "reading" | "link" | "note";

type BaseMaterial = {
  id: string;
  title: string;
  /** Rough time cost shown on the row, e.g. 25. */
  estimatedMinutes?: number;
  /** Optional/extension material — excluded from completion percentages. */
  optional?: boolean;
  /** Stream scope — see `ItemStreamIds`. */
  streamIds?: string[];
};

/**
 * STREAM SCOPE, shared verbatim by `Material`, `Exercise` and `ChecklistItem`.
 *
 * Absent OR empty means CORE: shown to every member of the run, whatever
 * stream they are on. A non-empty list names the `CourseRunStream` ids the
 * item belongs to, and a member sees it only if their `streamId` is in it.
 *
 * Both spellings of "core" are accepted deliberately. Absent is what every
 * pre-V3 week already stores and what the sanitisers emit (the house
 * absent-never-undefined rule); empty is what an editor leaves behind when
 * somebody selects streams and then deselects them all. Treating those two
 * differently would make an item silently vanish for the whole cohort.
 *
 * ONE READER. `src/lib/courses/streamScope.ts` is the single helper every
 * surface resolves this through — the week view, the curriculum list, the
 * progress page and the overview rail each count items independently today,
 * and a second interpretation shows one learner two different percentages for
 * the same week, which is worse than one wrong number.
 */
export type ItemStreamIds = string[];

export type VideoMaterial = BaseMaterial & {
  type: "video";
  /** YouTube URL (or bare id) — the renderer embeds via `youtubeIdFromUrl`. */
  url: string;
};

export type ReadingMaterial = BaseMaterial & {
  type: "reading";
  /** Link to the reading (paper, post, chapter). */
  url: string;
  /** Optional source attribution, e.g. "Ngo et al.". */
  author?: string;
};

export type LinkMaterial = BaseMaterial & {
  type: "link";
  url: string;
  /** One-line note on why this link is here. */
  description?: string;
};

export type NoteMaterial = BaseMaterial & {
  type: "note";
  /** Short authored aside rendered inline in the material list. Plain text. */
  body: string;
};

export type Material =
  | VideoMaterial
  | ReadingMaterial
  | LinkMaterial
  | NoteMaterial;

/**
 * The `streamIds` key as it is STORED, or `{}` when the item is core.
 *
 * Spread into a rebuilt row (`...streamIdsKey(raw)`) so an item with no stream
 * scope carries no key at all: Firestore refuses `undefined`, and an empty
 * array on every row of every week is bytes with no meaning (see
 * `ItemStreamIds` — absent and empty already mean the same thing).
 *
 * Ids are de-duplicated, order-preserved, and capped both per-id and in
 * number. Nothing here checks an id against the run's declared streams: the
 * canonical list lives on the run doc, the sanitiser only ever sees one week,
 * and `streamScope.ts` already treats an id that matches no stream as
 * "nobody's stream", which is a scoped item nobody sees rather than a leak.
 */
function streamIdsKey(raw: unknown): { streamIds?: string[] } {
  if (!Array.isArray(raw)) return {};
  const seen: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const id = value.slice(0, COURSE_FIELD_LIMITS.streamId);
    if (!id || seen.includes(id)) continue;
    seen.push(id);
    if (seen.length >= COURSE_FIELD_LIMITS.maxItemStreamIds) break;
  }
  return seen.length > 0 ? { streamIds: seen } : {};
}

/** Short, collision-unlikely material id for the week editor. */
export function newMaterialId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyMaterial(type: MaterialType): Material {
  const id = newMaterialId();
  switch (type) {
    case "video":
      return { id, type: "video", title: "", url: "" };
    case "reading":
      return { id, type: "reading", title: "", url: "" };
    case "link":
      return { id, type: "link", title: "", url: "" };
    case "note":
      return { id, type: "note", title: "", body: "" };
  }
}

/**
 * Structural check — never trust arbitrary Firestore data. Video materials
 * must carry a URL `youtubeIdFromUrl` can parse: the renderer embeds YouTube
 * and nothing else, so a non-YouTube video is authored as a "link" instead.
 */
export function isValidMaterial(raw: unknown): raw is Material {
  if (!raw || typeof raw !== "object") return false;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.title !== "string") return false;
  if (typeof m.type !== "string") return false;
  switch (m.type) {
    case "video":
      return typeof m.url === "string" && youtubeIdFromUrl(m.url) !== null;
    case "reading":
    case "link":
      return typeof m.url === "string";
    case "note":
      return typeof m.body === "string";
    default:
      return false;
  }
}

/**
 * REBUILT KEY-BY-KEY, like `sanitizeExercises` and `sanitizeChecklist` beside
 * it — never `{ ...m }`.
 *
 * The spread version kept every key the input happened to carry. That is
 * tolerable on a client-direct write to a doc the rules bound, and it is NOT
 * tolerable now that a facilitator's fork PATCH runs arbitrary request bodies
 * through this same sanitiser on its way into `courseGroups/{id}/weeks/{wNN}`:
 * unknown keys rode straight through, survived the route's per-field validation
 * (which only inspects the fields it knows), and accumulated in a document
 * whose only ceiling is Firestore's 1 MB. Thirty materials of junk is a week
 * nobody can save again.
 *
 * The output shape is unchanged for well-formed input, which is what keeps
 * every existing caller working: `normalizeCourseWeek` (the read path for both
 * canonical and forked weeks), the group-week PATCH route's
 * `materials.length !== body.materials.length` malformed check (this drops no
 * ROWS the old one kept), and `materialError`'s reads of `author`/
 * `description` — all of which are declared fields and all of which survive.
 * `isValidMaterial` has already proved `id`, `title`, `type` and the per-type
 * payload, so the rebuild below can trust exactly those.
 */
export function sanitizeMaterials(raw: unknown): Material[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidMaterial)
    .slice(0, COURSE_FIELD_LIMITS.maxMaterials)
    .map((m) => {
      const extra = m as {
        estimatedMinutes?: unknown;
        optional?: unknown;
        streamIds?: unknown;
      };
      const minutes = extra.estimatedMinutes;
      const base = {
        id: m.id,
        title: m.title,
        optional: Boolean(extra.optional),
        // Absent, never `undefined`: Firestore refuses `undefined`, and the
        // old code expressed this with a `delete` on a spread copy.
        ...(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
          ? { estimatedMinutes: Math.round(minutes) }
          : {}),
        // Added KEY-BY-KEY, which is the only way it can persist at all: this
        // function rebuilds every row explicitly and drops unknown keys by
        // design (see the doc comment), so a `streamIds` handled only in
        // `isValidMaterial` would validate and then silently disappear.
        ...streamIdsKey(extra.streamIds),
      };
      switch (m.type) {
        case "video":
          return { ...base, type: "video", url: m.url };
        case "reading":
          return {
            ...base,
            type: "reading",
            url: m.url,
            ...(typeof m.author === "string" && m.author ? { author: m.author } : {}),
          };
        case "link":
          return {
            ...base,
            type: "link",
            url: m.url,
            ...(typeof m.description === "string" && m.description
              ? { description: m.description }
              : {}),
          };
        case "note":
          return { ...base, type: "note", body: m.body };
      }
    });
}

// ---- Exercises (definitions — responses live in courseExercises.ts) ----

export type ExerciseResponseType = "text" | "link";

export type Exercise = {
  id: string;
  /** The prompt shown to the member. */
  prompt: string;
  /** Optional hint / clarification shown below the prompt. */
  helpText?: string;
  /**
   * Gates what the member may submit. Enforced SERVER-SIDE at submit time —
   * rules can't cross-check a response against its definition, which is why
   * exercise responses are routes-only.
   */
  responseType: ExerciseResponseType;
  required: boolean;
  /** Cap on a text response's length, clamped into [1, responseText limit]. */
  maxLength: number;
  /** When true, cohort members can read each other's responses. */
  peerVisible: boolean;
  /**
   * Rough time cost of answering, in minutes — the same budget line the
   * materials carry, so a week's total can be summed over readings AND
   * questions rather than over readings alone.
   */
  estimatedMinutes?: number;
  /** Stream scope — see `ItemStreamIds`. */
  streamIds?: string[];
};

export function newExerciseId(): string {
  return `x_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyExercise(): Exercise {
  return {
    id: newExerciseId(),
    prompt: "",
    responseType: "text",
    required: false,
    maxLength: EXERCISE_MAX_LENGTH_DEFAULT,
    peerVisible: false,
  };
}

export function isValidExercise(raw: unknown): raw is Exercise {
  if (!raw || typeof raw !== "object") return false;
  const x = raw as Record<string, unknown>;
  if (typeof x.id !== "string" || typeof x.prompt !== "string") return false;
  if (x.responseType !== "text" && x.responseType !== "link") return false;
  if (typeof x.maxLength !== "number" || !Number.isFinite(x.maxLength)) return false;
  return true;
}

/** Default text-response cap for a fresh exercise. */
export const EXERCISE_MAX_LENGTH_DEFAULT = 2000;

/** Hard ceiling on any text response — mirrors EXERCISE_LIMITS.responseText. */
const EXERCISE_MAX_LENGTH_CEILING = 4000;

export function sanitizeExercises(raw: unknown): Exercise[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidExercise)
    .slice(0, COURSE_FIELD_LIMITS.maxExercises)
    .map((x) => {
      const extra = x as {
        helpText?: unknown;
        required?: unknown;
        peerVisible?: unknown;
        estimatedMinutes?: unknown;
        streamIds?: unknown;
      };
      const minutes = extra.estimatedMinutes;
      return {
        id: x.id,
        prompt: x.prompt,
        ...(typeof extra.helpText === "string" && extra.helpText
          ? { helpText: extra.helpText }
          : {}),
        responseType: x.responseType,
        required: Boolean(extra.required),
        maxLength: Math.min(
          EXERCISE_MAX_LENGTH_CEILING,
          Math.max(1, Math.round(x.maxLength)),
        ),
        peerVisible: Boolean(extra.peerVisible),
        // Both optional keys are added here rather than in `isValidExercise`,
        // for the reason spelled out on `sanitizeMaterials`: this map rebuilds
        // the row and drops anything it does not name.
        ...(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
          ? { estimatedMinutes: Math.round(minutes) }
          : {}),
        ...streamIdsKey(extra.streamIds),
      };
    });
}

// ---- Checklist ----

export type ChecklistItem = {
  id: string;
  title: string;
  /** Optional expansion under the checkbox. */
  detail?: string;
  /**
   * When true, this item is projected as a subtask on the member's mirrored
   * My Work task (see courseTasks.ts). The item ID doubles as the subtask id,
   * so the projection stays idempotent across re-syncs.
   */
  mirrorToMyWork: boolean;
  /** Stream scope — see `ItemStreamIds`. */
  streamIds?: string[];
};

export function newChecklistItemId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyChecklistItem(): ChecklistItem {
  return { id: newChecklistItemId(), title: "", mirrorToMyWork: false };
}

export function isValidChecklistItem(raw: unknown): raw is ChecklistItem {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.title === "string";
}

export function sanitizeChecklist(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidChecklistItem)
    .slice(0, COURSE_FIELD_LIMITS.maxChecklistItems)
    .map((c) => {
      const extra = c as {
        detail?: unknown;
        mirrorToMyWork?: unknown;
        streamIds?: unknown;
      };
      return {
        id: c.id,
        title: c.title,
        ...(typeof extra.detail === "string" && extra.detail
          ? { detail: extra.detail }
          : {}),
        mirrorToMyWork: Boolean(extra.mirrorToMyWork),
        // Key-by-key, same reason as `sanitizeMaterials`.
        ...streamIdsKey(extra.streamIds),
      };
    });
}

// ---- Field limits ----

/**
 * Field length budgets for course authoring. Keep these in sync with
 * firestore.rules — client-side is for UX (maxLength + counters); the rules
 * (client-direct authoring paths) and routes are the security boundary.
 */
export const COURSE_FIELD_LIMITS = {
  title: 120,
  tagline: 200,
  level: 80,
  runLabel: 80,
  academicYear: 10,
  weekTitle: 120,
  weekSummary: 1000,
  materialTitle: 160,
  materialUrl: 500,
  materialAuthor: 120,
  materialDescription: 300,
  materialNoteBody: 1000,
  exercisePrompt: 1200,
  exerciseHelpText: 600,
  checklistTitle: 160,
  checklistDetail: 500,
  maxSummaryBlocks: 40,
  maxGuideBlocks: 40,
  maxWeekPlanEntries: 60,
  maxMaterials: 30,
  maxExercises: 15,
  maxChecklistItems: 15,
  maxCollaborators: 10,
  maxAdmissionsReviewers: 10,
  maxRunFacilitators: 10,
  maxTrackLeads: 5,
  /**
   * Streams per run. Six is generous against the three the incubator actually
   * needs, and small enough that a stream picker stays a row of chips rather
   * than a scrolling list.
   */
  maxStreams: 6,
  streamId: 40,
  streamLabel: 60,
  /**
   * Streams a single material / exercise / checklist item may be scoped to.
   * Matches `maxStreams`: scoping an item to every stream is the same thing
   * as leaving it core, but there is no reason to refuse the write.
   */
  maxItemStreamIds: 6,
} as const;

// ---- Submission URL validation ----

/** Same first-pass shape check as collaborators' optional-URL fields. */
const HTTP_URL = /^https?:\/\/[^\s.]+\.[^\s]+$/i;

/**
 * Validate a member-submitted URL (exercise link responses). Stricter than
 * `validateOptionalUrl`: after the regex, the URL must PARSE via `new URL()`,
 * carry an http/https protocol, and carry no userinfo — `https://user:pw@host`
 * URLs are a classic phishing shape and nothing legitimate needs them here.
 * Used by BOTH the client form (inline errors) and the submit route (the
 * security boundary). Returns an error string, or null when valid.
 */
export function validateSubmissionUrl(value: string, max: number): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "Please enter a link.";
  if (trimmed.length > max) return "That link is too long.";
  if (!HTTP_URL.test(trimmed)) {
    return "That doesn't look like a valid link (it should start with http:// or https://).";
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That doesn't look like a valid link.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Links must start with http:// or https://.";
  }
  if (url.username || url.password) {
    return "That link contains embedded credentials — please remove them.";
  }
  return null;
}

// ---- Normalisers ----

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

/** Normalize an unknown value into a de-duplicated list of uid strings. */
function asUidList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const u of v) {
    if (typeof u === "string" && u) seen.add(u);
  }
  return Array.from(seen);
}

function asCourseStatus(v: unknown): CourseStatus {
  return COURSE_STATUSES.includes(v as CourseStatus) ? (v as CourseStatus) : "draft";
}

function asCourseTrack(v: unknown): CourseTrack {
  return COURSE_TRACKS.includes(v as CourseTrack) ? (v as CourseTrack) : "general";
}

function asRunStatus(v: unknown): CourseRunStatus {
  return COURSE_RUN_STATUSES.includes(v as CourseRunStatus)
    ? (v as CourseRunStatus)
    : "draft";
}

function asPositiveIntOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v);
}

function asCount(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

/**
 * "YYYY-MM-DD" or empty string, never a partial, garbled, or IMPOSSIBLE date.
 *
 * `isValidDateKey` rather than a bare shape regex, because the shape is the
 * easy half. `2026-02-31` matches `\d{4}-\d{2}-\d{2}` and is not a day, so a
 * regex-only normaliser stores it happily and then every consumer of the run
 * degrades at once: `currentWeekFor` throws, so the guarded surfaces
 * (/learn, the rail, pacing, the nudge, the task mirror, the attendance
 * anchor) all fall back to "no dates" and the run looks alive while doing
 * nothing, with no error anywhere to explain it.
 *
 * This is also the ONLY layer that can make the check. `firestore.rules` has
 * no date arithmetic, so its regex is the strongest thing that layer can say
 * (a rule enumerating month lengths would still miss leap years). Normalising
 * an impossible date to "" makes it behave exactly like an unset one, which is
 * a state every reader already handles.
 */
function asCivilDate(v: unknown): string {
  return typeof v === "string" && isValidDateKey(v) ? v : "";
}

function isValidWeekPlanEntry(raw: unknown): raw is WeekPlanEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  if (e.kind === "week") {
    return typeof e.weekNumber === "number" && typeof e.weekId === "string";
  }
  if (e.kind === "break") {
    return typeof e.label === "string";
  }
  return false;
}

export function sanitizeWeekPlan(raw: unknown): WeekPlanEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isValidWeekPlanEntry)
    .slice(0, COURSE_FIELD_LIMITS.maxWeekPlanEntries);
}

/**
 * Absent (every pre-V3 run) and anything unrecognised normalise to
 * "admissions", which is the behaviour those runs already have. Open mode is
 * never reached by accident.
 */
function asEnrolMode(v: unknown): CourseEnrolMode {
  return COURSE_ENROL_MODES.includes(v as CourseEnrolMode)
    ? (v as CourseEnrolMode)
    : "admissions";
}

/**
 * Streams, de-duplicated on `id` and capped. A stream with no id is dropped
 * rather than defaulted: an id is what a week's `streamIds` and an
 * enrolment's `streamId` point at, so an id-less stream is unaddressable and
 * keeping it would show an empty chip nobody can be placed on.
 */
export function sanitizeStreams(raw: unknown): CourseRunStream[] {
  if (!Array.isArray(raw)) return [];
  const out: CourseRunStream[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const s = value as Record<string, unknown>;
    if (typeof s.id !== "string") continue;
    const id = s.id.slice(0, COURSE_FIELD_LIMITS.streamId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label:
        typeof s.label === "string"
          ? s.label.slice(0, COURSE_FIELD_LIMITS.streamLabel)
          : "",
    });
    if (out.length >= COURSE_FIELD_LIMITS.maxStreams) break;
  }
  return out;
}

/**
 * The submission pointer, or `null` for "this run has no submission bar".
 *
 * The null here is a READ-SIDE convenience only — `normalizeCourseRun` turns
 * it back into an ABSENT key, because a stored null wedges the rules pin (see
 * `SubmissionExerciseRef`). Both halves of the ref must be present: a pointer
 * naming a week with no exercise is not a weaker pointer, it is one that
 * silently marks nobody complete.
 */
function asSubmissionExerciseRef(v: unknown): SubmissionExerciseRef | null {
  if (!v || typeof v !== "object") return null;
  const ref = v as Record<string, unknown>;
  if (typeof ref.weekId !== "string" || !ref.weekId) return null;
  if (typeof ref.exerciseId !== "string" || !ref.exerciseId) return null;
  return { weekId: ref.weekId, exerciseId: ref.exerciseId };
}

function asApplicationCounts(v: unknown): ApplicationCounts {
  const raw = (v ?? {}) as Raw;
  return {
    pending: asCount(raw.pending),
    accepted: asCount(raw.accepted),
    rejected: asCount(raw.rejected),
    waitlisted: asCount(raw.waitlisted),
    withdrawn: asCount(raw.withdrawn),
  };
}

export function normalizeCourse(id: string, data: Raw): CourseDoc {
  return {
    id,
    title: (data.title as string) ?? "",
    tagline: (data.tagline as string) ?? "",
    summaryBlocks: sanitizeBlocks(data.summaryBlocks),
    track: asCourseTrack(data.track),
    level: (data.level as string) ?? "",
    estimatedWeeklyHours: asPositiveIntOrNull(data.estimatedWeeklyHours),
    status: asCourseStatus(data.status),
    showcaseRunId: (data.showcaseRunId as string | null | undefined) ?? null,
    authorUid: (data.authorUid as string) ?? "",
    collaboratorUids: asUidList(data.collaboratorUids),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}

export function normalizeCourseRun(id: string, data: Raw): CourseRunDoc {
  const doc: CourseRunDoc = {
    id,
    courseId: (data.courseId as string) ?? "",
    courseTitle: (data.courseTitle as string) ?? "",
    label: (data.label as string) ?? "",
    academicYear: (data.academicYear as string) ?? "",
    status: asRunStatus(data.status),
    enrolMode: asEnrolMode(data.enrolMode),
    streams: sanitizeStreams(data.streams),
    enrolledCount: asCount(data.enrolledCount),
    startDate: asCivilDate(data.startDate),
    weekPlan: sanitizeWeekPlan(data.weekPlan),
    applicationForm: sanitizeSignupForm(data.applicationForm),
    applicationsOpenAt: tsToDate(data.applicationsOpenAt),
    applicationsCloseAt: tsToDate(data.applicationsCloseAt),
    applicationCap: asPositiveIntOrNull(data.applicationCap),
    admissionsReviewerUids: asUidList(data.admissionsReviewerUids),
    runFacilitatorUids: asUidList(data.runFacilitatorUids),
    trackLeadUids: asUidList(data.trackLeadUids),
    applicationCounts: asApplicationCounts(data.applicationCounts),
    groupCount: asCount(data.groupCount),
    channel:
      typeof data.channel === "string" && data.channel
        ? data.channel
        : courseRunChannel(id),
    archived: data.archived === true,
    // Absent → null. The apply-template route writes STRINGS and never null,
    // because firestore.rules pins these with `get(field, '')` — a stored
    // null would compare unequal to the '' default and wedge every legitimate
    // non-admin run edit. Absent-or-string is the only shape on the wire.
    templateId:
      typeof data.templateId === "string" && data.templateId ? data.templateId : null,
    templateLabel:
      typeof data.templateLabel === "string" && data.templateLabel
        ? data.templateLabel
        : null,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
  // ABSENT, never null — the key is only ever set when a real pointer is
  // stored. See `SubmissionExerciseRef` for why a null here wedges the run.
  const submissionExerciseRef = asSubmissionExerciseRef(data.submissionExerciseRef);
  if (submissionExerciseRef) doc.submissionExerciseRef = submissionExerciseRef;
  return doc;
}

export function normalizeCourseWeek(id: string, data: Raw): CourseWeekDoc {
  return {
    id,
    weekNumber:
      typeof data.weekNumber === "number" && Number.isFinite(data.weekNumber)
        ? Math.floor(data.weekNumber)
        : 0,
    title: (data.title as string) ?? "",
    summary: (data.summary as string) ?? "",
    guideBlocks: sanitizeBlocks(data.guideBlocks),
    materials: sanitizeMaterials(data.materials),
    exercises: sanitizeExercises(data.exercises),
    checklist: sanitizeChecklist(data.checklist),
    estimatedMinutes: asPositiveIntOrNull(data.estimatedMinutes),
    published: data.published === true,
    updatedAt: tsToDate(data.updatedAt),
    updatedByUid: (data.updatedByUid as string | null | undefined) ?? null,
  };
}
