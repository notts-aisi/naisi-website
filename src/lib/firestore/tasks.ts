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

/**
 * Subtask templates applied automatically at task creation for kinds that have
 * a well-defined checklist. Empty array = no template (just the tasks-manager
 * subtasks users add manually). Future: attendee RSVP + capacity live on the
 * task itself, not in subtasks — tracked separately when the booking feature
 * lands.
 */
export const TASK_KIND_SUBTASK_TEMPLATES: Record<TaskKind, string[]> = {
  generic: [],
  "project-work": [],
  "fellowship-weekly": [],
  social: [
    "Pick date + time",
    "Book venue / pick location",
    "Create poster or graphic",
    "Announce on Instagram",
    "Announce in Slack / Discord",
    "Confirm rough numbers",
    "Run the social",
    "Post short debrief / photo",
  ],
  event: [
    "Confirm date + speaker(s)",
    "Book venue",
    "Create poster + any materials",
    "Open sign-ups / RSVP (when available)",
    "Announce on Instagram",
    "Announce in Slack / Discord",
    "Send reminder day-before",
    "Run event",
    "Share recording / resources afterwards",
  ],
  "instagram-post": [
    "Draft caption",
    "Create visual / carousel",
    "Copy approved",
    "Visual approved",
    "Scheduled in planner",
    "Posted",
    "Engagement check next day",
  ],
  "instagram-story": [
    "Create visual",
    "Draft caption / stickers",
    "Post story",
    "Check replies + engagement",
  ],
};

export const TASK_FIELD_LIMITS = {
  title: 120,
  description: 4000,
  subtaskTitle: 160,
  tag: 40,
  maxSubtasks: 50,
  maxAssignees: 10,
  maxTags: 8,
  commentBody: 2000,
} as const;

export type Subtask = {
  id: string;
  title: string;
  done: boolean;
  doneAt: Date | null;
  doneByUid: string | null;
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
  assigneeUids: string[];
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

function normalizeSubtask(raw: unknown): Subtask | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Raw;
  const id = typeof s.id === "string" ? s.id : null;
  const title = typeof s.title === "string" ? s.title : null;
  if (!id || !title) return null;
  return {
    id,
    title,
    done: Boolean(s.done),
    doneAt: tsToDate(s.doneAt),
    doneByUid: typeof s.doneByUid === "string" ? s.doneByUid : null,
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
    assigneeUids: Array.isArray(data.assigneeUids)
      ? (data.assigneeUids as unknown[]).filter((u): u is string => typeof u === "string")
      : [],
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
    tags: Array.isArray(data.tags)
      ? (data.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    sourceRef: normalizeSourceRef(data.sourceRef),
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
