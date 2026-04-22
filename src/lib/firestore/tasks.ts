export type TaskSource = "committee" | "fellowship-reminder" | "personal";

export type TaskKind =
  | "generic"
  | "instagram-post"
  | "instagram-story"
  | "project-work"
  | "fellowship-weekly"
  | "social"
  | "event";

export type TaskStatus = "backlog" | "todo" | "in-progress" | "review" | "done";
export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To-do",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
};

export type TaskPriority = "low" | "normal" | "high" | "urgent";
export const TASK_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export type TaskVisibility = "committee" | "assignees-only";

export const TASK_KINDS: TaskKind[] = [
  "generic",
  "project-work",
  "social",
  "event",
  "instagram-post",
  "instagram-story",
  "fellowship-weekly",
];
export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  generic: "General",
  "project-work": "Project work",
  social: "Social",
  event: "Event",
  "instagram-post": "Instagram post",
  "instagram-story": "Instagram story",
  "fellowship-weekly": "Fellowship weekly",
};

export const TASK_FIELD_LIMITS = {
  title: 120,
  description: 4000,
  subtaskTitle: 160,
  tag: 40,
  maxSubtasks: 50,
  maxCompleters: 10,
  maxReviewers: 5,
  maxAssigneesPerSubtask: 10,
  maxReviewersPerSubtask: 5,
  maxBlockedBy: 10,
  maxTags: 8,
  commentBody: 2000,
} as const;

export type Subtask = {
  id: string;
  title: string;
  done: boolean;
  doneAt: Date | null;
  doneByUid: string | null;
  assigneeUids: string[];
  /** Reviewers opted into approving this specific subtask. Empty → falls
   *  back to the task-level reviewerUids at render/gate time. */
  reviewerUids: string[];
  blockedBy: string[];
  /** Reviewer UIDs who have ticked ✓ on this subtask. Per review-matrix
   *  design: each reviewer's uid can appear in AT MOST ONE of
   *  approvedByReviewerUids / questionedByReviewerUids — they're mutually
   *  exclusive states. Phase 3 will add a third array, `rejectedByReviewerUids`,
   *  following the same pattern. */
  approvedByReviewerUids: string[];
  /** Reviewer UIDs who have flagged ❓ on this subtask — "I have a question,
   *  partially reviewed". Blocks their overall signoff (all-my-columns-✓)
   *  but not individual ticks on other subtasks. */
  questionedByReviewerUids: string[];
};

export type SubtaskStats = {
  done: number;
  total: number;
};

export type SourceRef = {
  cohortId: string;
  weekNumber: number;
} | null;

export type TaskDoc = {
  id: string;
  title: string;
  description: string;
  source: TaskSource;
  kind: TaskKind;
  projectId: string | null;
  creatorUid: string;
  completerUids: string[];
  reviewerUids: string[];
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  archived: boolean;
  visibility: TaskVisibility;
  subtasks: Subtask[];
  subtaskStats: SubtaskStats;
  attachmentCount: number;
  commentCount: number;
  tags: string[];
  sourceRef: SourceRef;
  sourceTemplateId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  completedAt: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((s): s is string => typeof s === "string");
}

function normalizeSubtask(raw: unknown): Subtask | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Raw;
  const id = typeof s.id === "string" ? s.id : null;
  const title = typeof s.title === "string" ? s.title : null;
  if (!id || !title) return null;
  // Legacy docs may carry a `roleHint` field — we ignore it; the review
  // matrix replaced that signal.
  return {
    id,
    title,
    done: Boolean(s.done),
    doneAt: tsToDate(s.doneAt),
    doneByUid: typeof s.doneByUid === "string" ? s.doneByUid : null,
    assigneeUids: stringArray(s.assigneeUids),
    reviewerUids: stringArray(s.reviewerUids),
    blockedBy: stringArray(s.blockedBy),
    approvedByReviewerUids: stringArray(s.approvedByReviewerUids),
    questionedByReviewerUids: stringArray(s.questionedByReviewerUids),
  };
}

function normalizeSourceRef(raw: unknown): SourceRef {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Raw;
  const cohortId = typeof s.cohortId === "string" ? s.cohortId : null;
  const weekNumber = typeof s.weekNumber === "number" ? s.weekNumber : null;
  if (!cohortId || weekNumber == null) return null;
  return { cohortId, weekNumber };
}

export function normalizeTask(id: string, data: Raw): TaskDoc {
  const rawSubtasks = Array.isArray(data.subtasks) ? (data.subtasks as unknown[]) : [];
  const subtasks = rawSubtasks
    .map(normalizeSubtask)
    .filter((s): s is Subtask => s !== null);
  const stats = (data.subtaskStats as Raw | undefined) ?? {};
  return {
    id,
    title: (data.title as string) ?? "Untitled",
    description: (data.description as string) ?? "",
    source: (data.source as TaskSource) ?? "committee",
    kind: (data.kind as TaskKind) ?? "generic",
    projectId: (data.projectId as string | null | undefined) ?? null,
    creatorUid: (data.creatorUid as string) ?? "",
    completerUids: stringArray(data.completerUids),
    reviewerUids: stringArray(data.reviewerUids),
    status: (data.status as TaskStatus) ?? "todo",
    priority: (data.priority as TaskPriority) ?? "normal",
    dueDate: tsToDate(data.dueDate),
    archived: Boolean(data.archived),
    visibility: (data.visibility as TaskVisibility) ?? "committee",
    subtasks,
    subtaskStats: {
      done: typeof stats.done === "number" ? stats.done : subtasks.filter((s) => s.done).length,
      total: typeof stats.total === "number" ? stats.total : subtasks.length,
    },
    attachmentCount: typeof data.attachmentCount === "number" ? data.attachmentCount : 0,
    commentCount: typeof data.commentCount === "number" ? data.commentCount : 0,
    tags: stringArray(data.tags),
    sourceRef: normalizeSourceRef(data.sourceRef),
    sourceTemplateId:
      typeof data.sourceTemplateId === "string" ? data.sourceTemplateId : null,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
    completedAt: tsToDate(data.completedAt),
  };
}

export function computeSubtaskStats(subtasks: Subtask[]): SubtaskStats {
  return { done: subtasks.filter((s) => s.done).length, total: subtasks.length };
}

/** Tasks are overdue if they have a dueDate in the past and aren't done/archived. */
export function isOverdue(task: TaskDoc, now: Date = new Date()): boolean {
  if (!task.dueDate) return false;
  if (task.status === "done" || task.archived) return false;
  return task.dueDate.getTime() < now.getTime();
}

/** Due within the next 48 hours (but not yet overdue). */
export function isDueSoon(task: TaskDoc, now: Date = new Date()): boolean {
  if (!task.dueDate) return false;
  if (task.status === "done" || task.archived) return false;
  const diff = task.dueDate.getTime() - now.getTime();
  return diff > 0 && diff < 48 * 60 * 60 * 1000;
}

/**
 * Effective reviewer set for a given subtask: the subtask's own
 * reviewerUids if non-empty, otherwise the task-level reviewerUids as a
 * fallback. An empty effective set means "no reviewer gate on this
 * subtask" — blue ticks resolve immediately.
 */
export function effectiveReviewerUids(
  subtask: Subtask,
  taskReviewerUids: string[],
): string[] {
  return subtask.reviewerUids.length > 0 ? subtask.reviewerUids : taskReviewerUids;
}

export type SubtaskApprovalStatus = {
  /** Reviewers expected to weigh in on this subtask. */
  required: string[];
  approved: string[];
  questioned: string[];
  /** Every required reviewer has placed ✓ — used by the per-reviewer
   *  overall-signoff derivation. */
  fullyApproved: boolean;
  /** At least one required reviewer has placed ✓ — the per-subtask
   *  threshold for blockedBy resolution. */
  hasAnyApproval: boolean;
  /** At least one reviewer has an outstanding ❓. Drives the orange row
   *  state regardless of whether others approved. */
  hasOutstandingQuestion: boolean;
};

export function getSubtaskApprovalStatus(
  subtask: Subtask,
  taskReviewerUids: string[],
): SubtaskApprovalStatus {
  const required = effectiveReviewerUids(subtask, taskReviewerUids);
  const requiredSet = new Set(required);
  const approved = subtask.approvedByReviewerUids.filter((u) => requiredSet.has(u));
  const questioned = subtask.questionedByReviewerUids.filter((u) => requiredSet.has(u));
  return {
    required,
    approved,
    questioned,
    fullyApproved: required.length > 0 && approved.length === required.length,
    hasAnyApproval: approved.length > 0,
    hasOutstandingQuestion: questioned.length > 0,
  };
}

/**
 * A subtask is tickable only when every blockedBy-reference resolves to a
 * sibling that is (a) `done: true` AND (b) meets its per-subtask approval
 * threshold (≥1 required reviewer has placed ✓, OR the blocker has no
 * required reviewers). Unknown blocker ids are fail-safe blocked — better
 * to lock a row than silently unlock on a dangling ref.
 */
export function isSubtaskBlocked(
  subtask: Subtask,
  siblings: Subtask[],
  taskReviewerUids: string[] = [],
): boolean {
  if (subtask.blockedBy.length === 0) return false;
  const byId = new Map(siblings.map((s) => [s.id, s]));
  return subtask.blockedBy.some((id) => {
    const blocker = byId.get(id);
    if (!blocker) return true; // unknown id = stay blocked
    if (!blocker.done) return true;
    const status = getSubtaskApprovalStatus(blocker, taskReviewerUids);
    // Blocker has required reviewers → they must have at least one ✓.
    if (status.required.length > 0 && !status.hasAnyApproval) return true;
    return false;
  });
}

export type RowState = "neutral" | "blue" | "orange" | "green";

/**
 * Derives the colour band for a subtask row given its current state + whether
 * a sent_for_review has already fired targeting it. Rules:
 *   - neutral: not done yet
 *   - orange: any outstanding ❓, OR sent-for-review is pending with approvals incomplete
 *   - green: fully approved (every required reviewer has ✓) OR done-with-no-reviewers
 *   - blue: done but approvals outstanding and no ❓ yet (the "waiting for review" resting state)
 */
export function subtaskRowState(
  subtask: Subtask,
  taskReviewerUids: string[],
  sentForReviewPending: boolean,
): RowState {
  if (!subtask.done) return "neutral";
  const status = getSubtaskApprovalStatus(subtask, taskReviewerUids);
  if (status.hasOutstandingQuestion) return "orange";
  if (status.required.length === 0) return "green"; // no review gate
  if (status.fullyApproved) return "green";
  if (sentForReviewPending) return "orange";
  return "blue";
}

/**
 * Task-level "done" gate: every subtask must be done, every subtask with
 * required reviewers must have at least one approval, and every task-level
 * reviewer must have ticked at least one ✓ somewhere (global coverage —
 * catches a reviewer who was listed but never engaged).
 */
export function canMarkTaskDone(task: TaskDoc): {
  ok: boolean;
  reason: string | null;
} {
  if (task.subtasks.length === 0) return { ok: true, reason: null };
  for (const s of task.subtasks) {
    if (!s.done) {
      return { ok: false, reason: `Subtask "${s.title}" is not marked done yet.` };
    }
    const status = getSubtaskApprovalStatus(s, task.reviewerUids);
    if (status.required.length > 0 && !status.hasAnyApproval) {
      return {
        ok: false,
        reason: `Subtask "${s.title}" is waiting on at least one reviewer approval.`,
      };
    }
  }
  // Global coverage — every task-level reviewer ticked ≥1 subtask somewhere.
  for (const reviewerUid of task.reviewerUids) {
    const ticked = task.subtasks.some((s) =>
      s.approvedByReviewerUids.includes(reviewerUid),
    );
    if (!ticked) {
      return {
        ok: false,
        reason: "A listed reviewer hasn't signed off on anything yet.",
      };
    }
  }
  return { ok: true, reason: null };
}
