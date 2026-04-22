import type { TaskKind } from "./tasks";

export const TASK_TEMPLATE_FIELD_LIMITS = {
  name: 80,
  description: 400,
  subtaskTitle: 160,
  maxSubtasks: 50,
  maxBlockedBy: 10,
} as const;

export type TemplateSubtask = {
  id: string;
  title: string;
  blockedBy: string[];
};

export type TaskTemplate = {
  id: string;
  name: string;
  description: string;
  kind: TaskKind | null;
  subtasks: TemplateSubtask[];
  defaultCompleterCount: number | null;
  createdByUid: string;
  createdAt: Date | null;
  updatedAt: Date | null;
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

function normalizeTemplateSubtask(raw: unknown): TemplateSubtask | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Raw;
  const id = typeof s.id === "string" ? s.id : null;
  const title = typeof s.title === "string" ? s.title : null;
  if (!id || !title) return null;
  // Legacy `roleHint` on template docs is ignored — the review matrix
  // replaced it at task-creation time.
  return {
    id,
    title,
    blockedBy: stringArray(s.blockedBy),
  };
}

export function normalizeTaskTemplate(id: string, data: Raw): TaskTemplate {
  const rawSubtasks = Array.isArray(data.subtasks) ? (data.subtasks as unknown[]) : [];
  const subtasks = rawSubtasks
    .map(normalizeTemplateSubtask)
    .filter((s): s is TemplateSubtask => s !== null);
  const rawKind = typeof data.kind === "string" ? (data.kind as TaskKind) : null;
  return {
    id,
    name: (data.name as string) ?? "Untitled template",
    description: (data.description as string) ?? "",
    kind: rawKind,
    subtasks,
    defaultCompleterCount:
      typeof data.defaultCompleterCount === "number" ? data.defaultCompleterCount : null,
    createdByUid: (data.createdByUid as string) ?? "",
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}

/**
 * Short, stable subtask IDs for templates. Chosen for readability in Firestore
 * console and the dependency graph editor. Uses crypto.randomUUID if available
 * (browser + node 20+), falling back to a timestamp + random suffix.
 */
export function newTemplateSubtaskId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `st_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
