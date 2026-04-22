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
  isSubtaskBlocked,
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

/**
 * Firestore shape for an embedded subtask — keep this and the `Subtask` type in
 * src/lib/firestore/tasks.ts aligned. Every writer below funnels through this
 * so new fields don't get dropped accidentally.
 */
function serializeSubtask(s: Subtask) {
  return {
    id: s.id,
    title: s.title,
    done: s.done,
    doneAt: s.doneAt ? Timestamp.fromDate(s.doneAt) : null,
    doneByUid: s.doneByUid,
    assigneeUids: s.assigneeUids,
    reviewerUids: s.reviewerUids,
    blockedBy: s.blockedBy,
    approvedByReviewerUids: s.approvedByReviewerUids,
    questionedByReviewerUids: s.questionedByReviewerUids,
  };
}

function clampUids(uids: string[] | undefined, max: number): string[] {
  if (!uids) return [];
  const unique = Array.from(new Set(uids.filter((u) => typeof u === "string" && u.length > 0)));
  return unique.slice(0, max);
}

export type CreateSubtaskInput = Pick<Subtask, "title"> &
  Partial<Pick<Subtask, "id" | "assigneeUids" | "reviewerUids" | "blockedBy">>;

export type CreateTaskInput = {
  title: string;
  description?: string;
  source: TaskSource;
  kind?: TaskKind;
  projectId?: string | null;
  completerUids: string[];
  reviewerUids?: string[];
  priority?: TaskPriority;
  dueDate?: Date | null;
  visibility?: TaskVisibility;
  subtasks?: CreateSubtaskInput[];
  tags?: string[];
  sourceTemplateId?: string | null;
};

export async function createTask(input: CreateTaskInput): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();

  const title = input.title.trim();
  if (!title) throw new Error("Title required");
  if (title.length > TASK_FIELD_LIMITS.title) {
    throw new Error(`Title must be ${TASK_FIELD_LIMITS.title} characters or fewer`);
  }

  const completerUids = clampUids(input.completerUids, TASK_FIELD_LIMITS.maxCompleters);
  const reviewerUids = clampUids(input.reviewerUids, TASK_FIELD_LIMITS.maxReviewers);
  const tags = (input.tags ?? []).slice(0, TASK_FIELD_LIMITS.maxTags);

  // When subtasks come from materialiseTemplate, ids are pre-populated and
  // blockedBy references those exact ids — preserve them. When subtasks come
  // from a freeform caller without ids, generate fresh ones.
  const rawSubtasks = (input.subtasks ?? []).slice(0, TASK_FIELD_LIMITS.maxSubtasks);
  const subtasks: Subtask[] = rawSubtasks.map((s) => ({
    id: s.id ?? genId(),
    title: s.title.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
    done: false,
    doneAt: null,
    doneByUid: null,
    assigneeUids: clampUids(s.assigneeUids, TASK_FIELD_LIMITS.maxAssigneesPerSubtask),
    reviewerUids: clampUids(s.reviewerUids, TASK_FIELD_LIMITS.maxReviewersPerSubtask),
    blockedBy: (s.blockedBy ?? []).slice(0, TASK_FIELD_LIMITS.maxBlockedBy),
    approvedByReviewerUids: [],
    questionedByReviewerUids: [],
  }));
  const validSubtaskIds = new Set(subtasks.map((s) => s.id));
  for (const s of subtasks) {
    s.blockedBy = s.blockedBy.filter((id) => validSubtaskIds.has(id) && id !== s.id);
  }

  const visibility: TaskVisibility =
    input.visibility ?? (input.source === "personal" ? "assignees-only" : "committee");

  const ref = await addDoc(collection(db, "tasks"), {
    title,
    description: (input.description ?? "").slice(0, TASK_FIELD_LIMITS.description),
    source: input.source,
    kind: input.kind ?? "generic",
    projectId: input.projectId ?? null,
    creatorUid: uid,
    completerUids,
    reviewerUids,
    status: "todo" as TaskStatus,
    priority: input.priority ?? "normal",
    dueDate: input.dueDate ? Timestamp.fromDate(input.dueDate) : null,
    archived: false,
    visibility,
    subtasks: subtasks.map(serializeSubtask),
    subtaskStats: { done: 0, total: subtasks.length },
    attachmentCount: 0,
    commentCount: 0,
    tags,
    sourceRef: null,
    sourceTemplateId: input.sourceTemplateId ?? null,
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
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (!target.done && isSubtaskBlocked(target, task.subtasks, task.reviewerUids)) {
    throw new Error("Subtask is blocked by an unfinished prerequisite");
  }
  const subtasks = task.subtasks.map<Subtask>((s) => {
    if (s.id !== subtaskId) return s;
    const nextDone = !s.done;
    return {
      ...s,
      done: nextDone,
      doneAt: nextDone ? new Date() : null,
      doneByUid: nextDone ? uid : null,
    };
  });
  const stats = computeSubtaskStats(subtasks);
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    subtaskStats: stats,
    updatedAt: serverTimestamp(),
  });
}

export async function addSubtask(
  task: TaskDoc,
  init: CreateSubtaskInput,
): Promise<string> {
  const db = getClientDb();
  const trimmed = init.title.trim();
  if (!trimmed) throw new Error("Subtask title required");
  if (task.subtasks.length >= TASK_FIELD_LIMITS.maxSubtasks) {
    throw new Error(`Max ${TASK_FIELD_LIMITS.maxSubtasks} subtasks per task`);
  }
  const next: Subtask = {
    id: genId(),
    title: trimmed.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
    done: false,
    doneAt: null,
    doneByUid: null,
    assigneeUids: clampUids(init.assigneeUids, TASK_FIELD_LIMITS.maxAssigneesPerSubtask),
    reviewerUids: clampUids(init.reviewerUids, TASK_FIELD_LIMITS.maxReviewersPerSubtask),
    blockedBy: (init.blockedBy ?? []).slice(0, TASK_FIELD_LIMITS.maxBlockedBy),
    approvedByReviewerUids: [],
    questionedByReviewerUids: [],
  };
  const subtasks = [...task.subtasks, next];
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    subtaskStats: computeSubtaskStats(subtasks),
    updatedAt: serverTimestamp(),
  });
  return next.id;
}

/**
 * Reorder subtasks. Accepts the desired id order; rebuilds the array by id so
 * all per-subtask fields survive (title, role arrays, blockedBy refs, done
 * state). Any ids missing from `orderedIds` are appended at the end rather
 * than dropped — defensive against a caller passing a partial list.
 *
 * `blockedBy` references IDs, not positions, so dependency edges stay correct
 * after reorder.
 */
export async function reorderSubtasks(task: TaskDoc, orderedIds: string[]) {
  const db = getClientDb();
  const byId = new Map(task.subtasks.map((s) => [s.id, s]));
  const next: Subtask[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      next.push(s);
      seen.add(id);
    }
  }
  for (const s of task.subtasks) {
    if (!seen.has(s.id)) next.push(s);
  }
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: next.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
}

export async function removeSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  // Drop references to this subtask from any sibling's blockedBy so the graph
  // doesn't end up with dangling refs that permanently block a row.
  const subtasks = task.subtasks
    .filter((s) => s.id !== subtaskId)
    .map((s) => ({ ...s, blockedBy: s.blockedBy.filter((id) => id !== subtaskId) }));
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    subtaskStats: computeSubtaskStats(subtasks),
    updatedAt: serverTimestamp(),
  });
}

async function patchSubtask(
  task: TaskDoc,
  subtaskId: string,
  patch: (s: Subtask) => Subtask,
) {
  const db = getClientDb();
  const subtasks = task.subtasks.map((s) => (s.id === subtaskId ? patch(s) : s));
  await updateDoc(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
}

export async function setSubtaskAssignees(task: TaskDoc, subtaskId: string, uids: string[]) {
  await patchSubtask(task, subtaskId, (s) => ({
    ...s,
    assigneeUids: clampUids(uids, TASK_FIELD_LIMITS.maxAssigneesPerSubtask),
  }));
}

export async function setSubtaskReviewers(task: TaskDoc, subtaskId: string, uids: string[]) {
  await patchSubtask(task, subtaskId, (s) => ({
    ...s,
    reviewerUids: clampUids(uids, TASK_FIELD_LIMITS.maxReviewersPerSubtask),
  }));
}

export async function setSubtaskBlockedBy(
  task: TaskDoc,
  subtaskId: string,
  blockedBy: string[],
) {
  const validIds = new Set(task.subtasks.map((s) => s.id).filter((id) => id !== subtaskId));
  const filtered = blockedBy
    .filter((id) => validIds.has(id))
    .slice(0, TASK_FIELD_LIMITS.maxBlockedBy);
  await patchSubtask(task, subtaskId, (s) => ({ ...s, blockedBy: filtered }));
}

export type ReviewState = "approve" | "question" | "clear";

/**
 * Reviewer marks their cell in the review matrix for a specific subtask.
 * Enforcement: caller must be one of the subtask's effective reviewers
 * (subtask.reviewerUids if non-empty, otherwise task.reviewerUids). A
 * reviewer can only ever move their OWN uid between the three cell states
 * — approve / question / clear — never touch another reviewer's entry.
 *
 * Rules can't enforce the own-uid-only constraint (array element checks on
 * a subtask inside a subtasks array are too expensive in Firestore rules),
 * but we rely on the narrow-write band as the broader gate and trust the
 * committee + this client guard. Phase 3 will add rejectedByReviewerUids.
 */
export async function setSubtaskApproval(
  task: TaskDoc,
  subtaskId: string,
  state: ReviewState,
) {
  const uid = actingUid();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  const effectiveReviewers =
    target.reviewerUids.length > 0 ? target.reviewerUids : task.reviewerUids;
  if (!effectiveReviewers.includes(uid)) {
    throw new Error("You're not listed as a reviewer for this subtask.");
  }
  await patchSubtask(task, subtaskId, (s) => {
    // Mutually exclusive: remove uid from both arrays first, then add to
    // the appropriate one (or to neither, for "clear").
    const approved = s.approvedByReviewerUids.filter((u) => u !== uid);
    const questioned = s.questionedByReviewerUids.filter((u) => u !== uid);
    if (state === "approve") approved.push(uid);
    if (state === "question") questioned.push(uid);
    return {
      ...s,
      approvedByReviewerUids: approved,
      questionedByReviewerUids: questioned,
    };
  });
}

export async function renameSubtask(task: TaskDoc, subtaskId: string, title: string) {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Subtask title required");
  await patchSubtask(task, subtaskId, (s) => ({
    ...s,
    title: trimmed.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
  }));
}

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  projectId?: string | null;
  completerUids?: string[];
  reviewerUids?: string[];
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
  if (fields.completerUids !== undefined) {
    patch.completerUids = clampUids(fields.completerUids, TASK_FIELD_LIMITS.maxCompleters);
  }
  if (fields.reviewerUids !== undefined) {
    patch.reviewerUids = clampUids(fields.reviewerUids, TASK_FIELD_LIMITS.maxReviewers);
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

export async function setTaskCompleters(taskId: string, completerUids: string[]) {
  await updateTask(taskId, { completerUids });
}

export async function setTaskReviewers(taskId: string, reviewerUids: string[]) {
  await updateTask(taskId, { reviewerUids });
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
