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

export type SubtaskRoleHint = "completer" | "reviewer" | null;

export type Subtask = {
  id: string;
  title: string;
  done: boolean;
  doneAt: Date | null;
  doneByUid: string | null;
  assigneeUids: string[];
  reviewerUids: string[];
  blockedBy: string[];
  roleHint: SubtaskRoleHint;
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
  const rawHint = typeof s.roleHint === "string" ? s.roleHint : null;
  const roleHint: SubtaskRoleHint =
    rawHint === "completer" || rawHint === "reviewer" ? rawHint : null;
  return {
    id,
    title,
    done: Boolean(s.done),
    doneAt: tsToDate(s.doneAt),
    doneByUid: typeof s.doneByUid === "string" ? s.doneByUid : null,
    assigneeUids: stringArray(s.assigneeUids),
    reviewerUids: stringArray(s.reviewerUids),
    blockedBy: stringArray(s.blockedBy),
    roleHint,
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
 * A subtask is tickable only when every id in its `blockedBy` resolves to a
 * sibling subtask with `done: true`. Unknown blocker ids are treated as blocked
 * (fail-safe: if someone edits templates or reorders and leaves a stale ref,
 * the row stays locked rather than silently unlocking).
 */
export function isSubtaskBlocked(subtask: Subtask, siblings: Subtask[]): boolean {
  if (subtask.blockedBy.length === 0) return false;
  const doneIds = new Set(siblings.filter((s) => s.done).map((s) => s.id));
  return subtask.blockedBy.some((id) => !doneIds.has(id));
}
