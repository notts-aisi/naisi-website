"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import {
  TASK_FIELD_LIMITS,
  computeSubtaskStats,
  type Subtask,
  type TaskDoc,
  type TaskKind,
  type TaskPriority,
  type TaskSource,
  type TaskStatus,
  type TaskVisibility,
} from "@/lib/firestore/tasks";

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type CreateTaskInput = {
  title: string;
  description?: string;
  source: TaskSource;
  kind?: TaskKind;
  projectId?: string | null;
  assigneeUids: string[];
  priority?: TaskPriority;
  dueDate?: Date | null;
  visibility?: TaskVisibility;
  subtasks?: Pick<Subtask, "title">[];
  tags?: string[];
};

export async function createTask(input: CreateTaskInput): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();

  const title = input.title.trim();
  if (!title) throw new Error("Title required");
  if (title.length > TASK_FIELD_LIMITS.title) {
    throw new Error(`Title must be ${TASK_FIELD_LIMITS.title} characters or fewer`);
  }

  const assigneeUids = (input.assigneeUids ?? []).slice(0, TASK_FIELD_LIMITS.maxAssignees);
  const tags = (input.tags ?? []).slice(0, TASK_FIELD_LIMITS.maxTags);
  const subtasks: Subtask[] = (input.subtasks ?? [])
    .slice(0, TASK_FIELD_LIMITS.maxSubtasks)
    .map((s) => ({
      id: genId(),
      title: s.title.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
      done: false,
      doneAt: null,
      doneByUid: null,
    }));

  const visibility: TaskVisibility =
    input.visibility ?? (input.source === "personal" ? "assignees-only" : "committee");

  const ref = await addDoc(collection(db, "tasks"), {
    title,
    description: (input.description ?? "").slice(0, TASK_FIELD_LIMITS.description),
    source: input.source,
    kind: input.kind ?? "generic",
    projectId: input.projectId ?? null,
    creatorUid: uid,
    assigneeUids,
    status: "todo" as TaskStatus,
    priority: input.priority ?? "normal",
    dueDate: input.dueDate ? Timestamp.fromDate(input.dueDate) : null,
    archived: false,
    visibility,
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      done: false,
      doneAt: null,
      doneByUid: null,
    })),
    subtaskStats: { done: 0, total: subtasks.length },
    attachmentCount: 0,
    commentCount: 0,
    tags,
    sourceRef: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
  });
  return ref.id;
}

export async function setTaskStatus(task: TaskDoc, status: TaskStatus) {
  const db = getClientDb();
  const patch: Record<string, unknown> = {
    status,
    updatedAt: serverTimestamp(),
  };
  if (status === "done" && task.status !== "done") {
    patch.completedAt = serverTimestamp();
  } else if (status !== "done" && task.status === "done") {
    patch.completedAt = deleteField();
  }
  await updateDoc(doc(db, "tasks", task.id), patch);
}

export async function toggleSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const now = Timestamp.now();
  const subtasks = task.subtasks.map<Subtask>((s) => {
    if (s.id !== subtaskId) return s;
    const nextDone = !s.done;
    return {
      ...s,
      done: nextDone,
      doneAt: nextDone ? now.toDate() : null,
      doneByUid: nextDone ? uid : null,
    };
  });
  const stats = computeSubtaskStats(subtasks);
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      done: s.done,
      doneAt: s.doneAt ? Timestamp.fromDate(s.doneAt) : null,
      doneByUid: s.doneByUid,
    })),
    subtaskStats: stats,
    updatedAt: serverTimestamp(),
  });
}

export async function addSubtask(task: TaskDoc, title: string) {
  const db = getClientDb();
  const trimmed = title.trim();
  if (!trimmed) return;
  if (task.subtasks.length >= TASK_FIELD_LIMITS.maxSubtasks) {
    throw new Error(`Max ${TASK_FIELD_LIMITS.maxSubtasks} subtasks per task`);
  }
  const next: Subtask = {
    id: genId(),
    title: trimmed.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
    done: false,
    doneAt: null,
    doneByUid: null,
  };
  const subtasks = [...task.subtasks, next];
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      done: s.done,
      doneAt: s.doneAt ? Timestamp.fromDate(s.doneAt) : null,
      doneByUid: s.doneByUid,
    })),
    subtaskStats: computeSubtaskStats(subtasks),
    updatedAt: serverTimestamp(),
  });
}

export async function removeSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const subtasks = task.subtasks.filter((s) => s.id !== subtaskId);
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      done: s.done,
      doneAt: s.doneAt ? Timestamp.fromDate(s.doneAt) : null,
      doneByUid: s.doneByUid,
    })),
    subtaskStats: computeSubtaskStats(subtasks),
    updatedAt: serverTimestamp(),
  });
}

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  projectId?: string | null;
  assigneeUids?: string[];
  priority?: TaskPriority;
  dueDate?: Date | null;
  kind?: TaskKind;
  tags?: string[];
};

export async function updateTask(taskId: string, fields: UpdateTaskInput) {
  const db = getClientDb();
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (fields.title !== undefined) {
    const t = fields.title.trim();
    if (!t) throw new Error("Title required");
    patch.title = t.slice(0, TASK_FIELD_LIMITS.title);
  }
  if (fields.description !== undefined) {
    patch.description = fields.description.slice(0, TASK_FIELD_LIMITS.description);
  }
  if (fields.projectId !== undefined) patch.projectId = fields.projectId ?? null;
  if (fields.assigneeUids !== undefined) {
    patch.assigneeUids = fields.assigneeUids.slice(0, TASK_FIELD_LIMITS.maxAssignees);
  }
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.dueDate !== undefined) {
    patch.dueDate = fields.dueDate ? Timestamp.fromDate(fields.dueDate) : null;
  }
  if (fields.kind !== undefined) patch.kind = fields.kind;
  if (fields.tags !== undefined) {
    patch.tags = fields.tags.slice(0, TASK_FIELD_LIMITS.maxTags);
  }
  await updateDoc(doc(db, "tasks", taskId), patch);
}

export async function assignTask(taskId: string, assigneeUids: string[]) {
  await updateTask(taskId, { assigneeUids });
}

export async function setTaskVisibility(taskId: string, visibility: TaskVisibility) {
  const db = getClientDb();
  await updateDoc(doc(db, "tasks", taskId), {
    visibility,
    updatedAt: serverTimestamp(),
  });
}

export async function archiveTask(taskId: string, archived: boolean) {
  const db = getClientDb();
  await updateDoc(doc(db, "tasks", taskId), {
    archived,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteTask(taskId: string) {
  const db = getClientDb();
  await deleteDoc(doc(db, "tasks", taskId));
}
