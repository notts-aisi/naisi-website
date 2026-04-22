"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import {
  TASK_TEMPLATE_FIELD_LIMITS,
  newTemplateSubtaskId,
  type TaskTemplate,
  type TemplateSubtask,
} from "@/lib/firestore/taskTemplates";
import type { TaskKind } from "@/lib/firestore/tasks";

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export type CreateTemplateInput = {
  name: string;
  description?: string;
  kind?: TaskKind | null;
  subtasks?: Array<Partial<TemplateSubtask> & { title: string }>;
  defaultCompleterCount?: number | null;
};

function sanitizeSubtasks(
  raw: CreateTemplateInput["subtasks"] = [],
): TemplateSubtask[] {
  const limited = raw.slice(0, TASK_TEMPLATE_FIELD_LIMITS.maxSubtasks);
  // Remap any provided ids → fresh stable ids so cross-referenced `blockedBy`
  // survives the normalisation. Callers can pre-generate ids if they want, but
  // incoming data is not trusted to be collision-free.
  const idMap = new Map<string, string>();
  const withIds = limited.map((s) => {
    const oldId = s.id ?? newTemplateSubtaskId();
    const newId = newTemplateSubtaskId();
    idMap.set(oldId, newId);
    return { ...s, _oldId: oldId, id: newId };
  });
  return withIds.map<TemplateSubtask>((s) => ({
    id: s.id,
    title: s.title.slice(0, TASK_TEMPLATE_FIELD_LIMITS.subtaskTitle),
    blockedBy: (s.blockedBy ?? [])
      .map((id) => idMap.get(id) ?? null)
      .filter((id): id is string => Boolean(id))
      .slice(0, TASK_TEMPLATE_FIELD_LIMITS.maxBlockedBy),
  }));
}

export async function createTemplate(input: CreateTemplateInput): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();
  const name = input.name.trim();
  if (!name) throw new Error("Template name required");
  if (name.length > TASK_TEMPLATE_FIELD_LIMITS.name) {
    throw new Error(`Name must be ${TASK_TEMPLATE_FIELD_LIMITS.name} characters or fewer`);
  }
  const ref = await addDoc(collection(db, "taskTemplates"), {
    name,
    description: (input.description ?? "").slice(0, TASK_TEMPLATE_FIELD_LIMITS.description),
    kind: input.kind ?? null,
    subtasks: sanitizeSubtasks(input.subtasks),
    defaultCompleterCount: input.defaultCompleterCount ?? null,
    createdByUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export type UpdateTemplateInput = Partial<Omit<CreateTemplateInput, "subtasks">> & {
  subtasks?: TemplateSubtask[];
};

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  const db = getClientDb();
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) throw new Error("Template name required");
    patch.name = trimmed.slice(0, TASK_TEMPLATE_FIELD_LIMITS.name);
  }
  if (input.description !== undefined) {
    patch.description = input.description.slice(0, TASK_TEMPLATE_FIELD_LIMITS.description);
  }
  if (input.kind !== undefined) patch.kind = input.kind ?? null;
  if (input.defaultCompleterCount !== undefined) {
    patch.defaultCompleterCount = input.defaultCompleterCount;
  }
  if (input.subtasks !== undefined) {
    // For updates we preserve existing ids — the caller is trusted to keep
    // blockedBy references pointed at valid ids. Only the subtask shape is
    // normalised.
    const limited = input.subtasks.slice(0, TASK_TEMPLATE_FIELD_LIMITS.maxSubtasks);
    const validIds = new Set(limited.map((s) => s.id));
    patch.subtasks = limited.map((s) => ({
      id: s.id,
      title: s.title.slice(0, TASK_TEMPLATE_FIELD_LIMITS.subtaskTitle),
      blockedBy: s.blockedBy
        .filter((bid) => bid !== s.id && validIds.has(bid))
        .slice(0, TASK_TEMPLATE_FIELD_LIMITS.maxBlockedBy),
    }));
  }
  await updateDoc(doc(db, "taskTemplates", id), patch);
}

export async function deleteTemplate(id: string) {
  const db = getClientDb();
  await deleteDoc(doc(db, "taskTemplates", id));
}

/** Materialise a template into CreateSubtaskInput rows for a new task. */
export function materialiseTemplate(template: TaskTemplate) {
  // Remap template subtask ids → fresh ids for the task, carrying blockedBy refs.
  const idMap = new Map<string, string>();
  const fresh = template.subtasks.map((s) => {
    const newId = newTemplateSubtaskId();
    idMap.set(s.id, newId);
    return { ...s, id: newId };
  });
  return fresh.map((s) => ({
    title: s.title,
    assigneeUids: [] as string[],
    reviewerUids: [] as string[],
    blockedBy: s.blockedBy
      .map((id) => idMap.get(id) ?? null)
      .filter((id): id is string => Boolean(id)),
  }));
}
