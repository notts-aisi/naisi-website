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
  writeBatch,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import {
  TASK_FIELD_LIMITS,
  computeSubtaskStats,
  getBlockConsensusState,
  getBlockEffectiveReviewerUids,
  getBlockReviewSubtaskIds,
  getNextBlock,
  getReviewerSignoffBlockers,
  hasReviewerSignedOffBlock,
  isBlockGateApplied,
  isSubtaskBlocked,
  type BlockConsentMap,
  type Subtask,
  type TaskBlock,
  type TaskDoc,
  type TaskKind,
  type TaskPriority,
  type TaskSource,
  type TaskStatus,
  type TaskVisibility,
} from "@/lib/firestore/tasks";
import { queueActivity } from "./activityLog";

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
    description: s.description,
    dueDate: s.dueDate ? Timestamp.fromDate(s.dueDate) : null,
    done: s.done,
    doneAt: s.doneAt ? Timestamp.fromDate(s.doneAt) : null,
    doneByUid: s.doneByUid,
    assigneeUids: s.assigneeUids,
    reviewerUids: s.reviewerUids,
    blockedBy: s.blockedBy,
    approvedByReviewerUids: s.approvedByReviewerUids,
    questionedByReviewerUids: s.questionedByReviewerUids,
    rejectedByReviewerUids: s.rejectedByReviewerUids,
    blockId: s.blockId,
    sealState: s.sealState,
    sealedAt: s.sealedAt ? Timestamp.fromDate(s.sealedAt) : null,
    roleHint: s.roleHint,
  };
}

/**
 * Build the review subtasks that should exist in a block once it's sealed —
 * one row per effective reviewer, skipping reviewers who already have a
 * review subtask in this block (idempotent under re-seal after admin
 * un-seal). Caller is responsible for appending the returned rows to
 * `task.subtasks` in the same write.
 */
function planReviewSpawn(task: TaskDoc, blockId: string): Subtask[] {
  const reviewers = getBlockEffectiveReviewerUids(task, blockId);
  if (reviewers.length === 0) return [];
  const existingByReviewer = new Set<string>();
  for (const s of task.subtasks) {
    if (s.blockId !== blockId || s.roleHint !== "reviewer") continue;
    for (const u of s.reviewerUids) existingByReviewer.add(u);
  }
  const out: Subtask[] = [];
  for (const reviewerUid of reviewers) {
    if (existingByReviewer.has(reviewerUid)) continue;
    out.push({
      id: genId(),
      title: "Reviewer signoff",
      description: "",
      dueDate: null,
      done: false,
      doneAt: null,
      doneByUid: null,
      assigneeUids: [],
      reviewerUids: [reviewerUid],
      blockedBy: [],
      approvedByReviewerUids: [],
      questionedByReviewerUids: [],
      rejectedByReviewerUids: [],
      blockId,
      sealState: "open",
      sealedAt: null,
      roleHint: "reviewer",
    });
  }
  return out;
}

function serializeBlock(b: TaskBlock) {
  return {
    id: b.id,
    name: b.name,
    order: b.order,
    sealState: b.sealState,
    sealedAt: b.sealedAt ? Timestamp.fromDate(b.sealedAt) : null,
    forceSealedByUid: b.forceSealedByUid,
  };
}

function clampUids(uids: string[] | undefined, max: number): string[] {
  if (!uids) return [];
  const unique = Array.from(new Set(uids.filter((u) => typeof u === "string" && u.length > 0)));
  return unique.slice(0, max);
}

export type CreateSubtaskInput = Pick<Subtask, "title"> &
  Partial<Pick<Subtask, "id" | "description" | "dueDate" | "assigneeUids" | "reviewerUids" | "blockedBy" | "blockId" | "roleHint">>;

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
    description: (s.description ?? "").slice(0, TASK_FIELD_LIMITS.subtaskDescription),
    dueDate: s.dueDate ?? null,
    done: false,
    doneAt: null,
    doneByUid: null,
    assigneeUids: clampUids(s.assigneeUids, TASK_FIELD_LIMITS.maxAssigneesPerSubtask),
    reviewerUids: clampUids(s.reviewerUids, TASK_FIELD_LIMITS.maxReviewersPerSubtask),
    blockedBy: (s.blockedBy ?? []).slice(0, TASK_FIELD_LIMITS.maxBlockedBy),
    approvedByReviewerUids: [],
    questionedByReviewerUids: [],
    rejectedByReviewerUids: [],
    blockId: s.blockId ?? null,
    sealState: "open",
    sealedAt: null,
    roleHint: s.roleHint ?? null,
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
    blocks: [],
    blockConsents: {},
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

/**
 * `opts.asAdmin` lets the caller bypass the reviewer-hint signoff
 * restrictions — admins need to be able to untick a retracted reviewer
 * signoff, tick on a reviewer's behalf in emergencies, etc. Callers pass
 * `{ asAdmin: isAdmin }` using their own role check; admin status isn't
 * verified here (consistent with the rest of Phase 3's client-enforced
 * permission model).
 */
export async function toggleSubtask(
  task: TaskDoc,
  subtaskId: string,
  opts: { asAdmin?: boolean } = {},
) {
  const db = getClientDb();
  const uid = actingUid();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  const nextDone = !target.done;
  const asAdmin = opts.asAdmin === true;
  if (nextDone && isSubtaskBlocked(target, task.subtasks, task.reviewerUids)) {
    throw new Error("Subtask is blocked by an unfinished prerequisite");
  }
  // Stage 1.5a gap-fix: work on completion rows can't start until the
  // parent block has had its allocation locked in. Admin bypass preserved.
  if (nextDone && !asAdmin && target.roleHint !== "reviewer" && target.blockId) {
    const parentBlock = task.blocks.find((b) => b.id === target.blockId);
    if (parentBlock && parentBlock.sealState !== "sealed") {
      throw new Error(
        "Lock in the block's allocation before starting work on its subtasks.",
      );
    }
  }
  // Reviewer-signoff rows:
  //   - Ticking: only the listed reviewer (or admin), with approve-first gate.
  //   - Unticking (retracting signoff): admin only. Once a reviewer has
  //     signed off, they can't silently retract — the audit value of a
  //     signoff depends on it being sticky.
  if (target.roleHint === "reviewer") {
    if (nextDone) {
      if (!asAdmin && !target.reviewerUids.includes(uid)) {
        throw new Error("Only the listed reviewer can sign off this row.");
      }
      if (!asAdmin) {
        const outstanding = getReviewerSignoffBlockers(task, target, uid);
        if (outstanding.length > 0) {
          const first = outstanding[0];
          const reason =
            first.reason === "not-done"
              ? "isn't ticked done yet"
              : first.reason === "rejected-by-me"
                ? "is still marked rejected — resolve before signing off"
                : "hasn't been approved by you yet";
          const more =
            outstanding.length > 1 ? ` (+${outstanding.length - 1} more)` : "";
          throw new Error(
            `Can't sign off — "${first.title}" ${reason}${more}.`,
          );
        }
      }
    } else {
      if (!asAdmin) {
        throw new Error(
          "Reviewer signoff can only be retracted by an admin once ticked.",
        );
      }
    }
  } else {
    // Regular completion rows: only listed assignees (or any completer on
    // an empty-assignees open row) can tick. Admins can bypass via the
    // `asAdmin` flag for oversight cases. The task-creator bypass was
    // dropped 2026-04-23 (Stage 1.5a) — creators who want to move work
    // forward should self-add to the subtask via the `+ Me` affordance so
    // the tick is attributed to someone doing the work.
    const isAssigned = target.assigneeUids.includes(uid);
    const isCompleterOnTask = task.completerUids.includes(uid);
    const anyoneWhoCan =
      target.assigneeUids.length === 0 && isCompleterOnTask;
    if (!asAdmin && !isAssigned && !anyoneWhoCan) {
      throw new Error(
        target.assigneeUids.length === 0
          ? "Only task completers can tick subtasks on this task."
          : "This subtask is assigned to specific people — add yourself or ask an assignee to tick.",
      );
    }
  }
  const subtasks = task.subtasks.map<Subtask>((s) => {
    if (s.id !== subtaskId) return s;
    const nextDone = !s.done;
    // Re-review cycle: completer un-ticking (nextDone=false) OR re-ticking
    // after a prior rejection wipes reviewer state so reviewers are asked
    // fresh. This is the resend-after-fix path — prior ✓ / ❓ / ❌ become
    // stale the moment the work is un-done or re-submitted.
    const wipeReviewState =
      !nextDone || s.rejectedByReviewerUids.length > 0;
    return {
      ...s,
      done: nextDone,
      doneAt: nextDone ? new Date() : null,
      doneByUid: nextDone ? uid : null,
      approvedByReviewerUids: wipeReviewState ? [] : s.approvedByReviewerUids,
      questionedByReviewerUids: wipeReviewState ? [] : s.questionedByReviewerUids,
      rejectedByReviewerUids: wipeReviewState ? [] : s.rejectedByReviewerUids,
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
  const blockId = resolveBlockId(task, init.blockId ?? null);
  const next: Subtask = {
    id: genId(),
    title: trimmed.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
    description: (init.description ?? "").slice(0, TASK_FIELD_LIMITS.subtaskDescription),
    dueDate: init.dueDate ?? null,
    done: false,
    doneAt: null,
    doneByUid: null,
    assigneeUids: clampUids(init.assigneeUids, TASK_FIELD_LIMITS.maxAssigneesPerSubtask),
    reviewerUids: clampUids(init.reviewerUids, TASK_FIELD_LIMITS.maxReviewersPerSubtask),
    blockedBy: (init.blockedBy ?? []).slice(0, TASK_FIELD_LIMITS.maxBlockedBy),
    approvedByReviewerUids: [],
    questionedByReviewerUids: [],
    rejectedByReviewerUids: [],
    blockId,
    sealState: "open",
    sealedAt: null,
    roleHint: init.roleHint ?? null,
  };
  const subtasks = [...task.subtasks, next];
  // Adding a subtask into an open block invalidates existing lock-in —
  // the new row changes the allocation picture, so consent resets to 0.
  const patch: Record<string, unknown> = {
    subtasks: subtasks.map(serializeSubtask),
    subtaskStats: computeSubtaskStats(subtasks),
    updatedAt: serverTimestamp(),
  };
  const consentsPatch = clearConsentIfOpen(task, blockId);
  if (consentsPatch) patch.blockConsents = consentsPatch;
  await updateDoc(doc(db, "tasks", task.id), patch);
  return next.id;
}

/**
 * Resolve the blockId a new subtask should land in. If the caller passed an
 * explicit id that matches an existing block, honour it. If they passed null
 * and the task has blocks but no ungrouped rows yet, default to the last
 * block (matches the UX of "Add subtask" buttons rendered inside a block
 * footer). Otherwise leave as null.
 */
function resolveBlockId(task: TaskDoc, requested: string | null): string | null {
  if (requested && task.blocks.some((b) => b.id === requested)) return requested;
  return null;
}

/**
 * If `blockId` refers to an open block, return a new `blockConsents` map with
 * that block's consent list cleared to []. Returns null when there's nothing
 * to change — callers use that as "skip the write". Sealed blocks (and the
 * ungrouped null block) are no-ops.
 */
function clearConsentIfOpen(
  task: TaskDoc,
  blockId: string | null,
): BlockConsentMap | null {
  if (!blockId) return null;
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block || block.sealState !== "open") return null;
  const existing = task.blockConsents[blockId];
  if (!existing || existing.consentingCompleterUids.length === 0) return null;
  return {
    ...task.blockConsents,
    [blockId]: { consentingCompleterUids: [] },
  };
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
  const target = task.subtasks.find((s) => s.id === subtaskId);
  // Drop references to this subtask from any sibling's blockedBy so the graph
  // doesn't end up with dangling refs that permanently block a row.
  const subtasks = task.subtasks
    .filter((s) => s.id !== subtaskId)
    .map((s) => ({ ...s, blockedBy: s.blockedBy.filter((id) => id !== subtaskId) }));
  const patch: Record<string, unknown> = {
    subtasks: subtasks.map(serializeSubtask),
    subtaskStats: computeSubtaskStats(subtasks),
    updatedAt: serverTimestamp(),
  };
  const consentsPatch = clearConsentIfOpen(task, target?.blockId ?? null);
  if (consentsPatch) patch.blockConsents = consentsPatch;
  await updateDoc(doc(db, "tasks", task.id), patch);
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
  const db = getClientDb();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (target.sealState === "sealed") {
    throw new Error("Subtask is sealed — an admin must unseal before roster changes.");
  }
  // Caller permission (admin / creator) is gated in the UI — the picker
  // isn't rendered for anyone else. Phase 3 is client-enforced because
  // Firestore rules can't affordably diff nested arrays to check
  // "only-self-changes" semantics.
  const next = clampUids(uids, TASK_FIELD_LIMITS.maxAssigneesPerSubtask);
  const subtasks = task.subtasks.map((s) =>
    s.id === subtaskId ? { ...s, assigneeUids: next } : s,
  );
  const patch: Record<string, unknown> = {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  };
  const consentsPatch = clearConsentIfOpen(task, target.blockId);
  if (consentsPatch) patch.blockConsents = consentsPatch;
  await updateDoc(doc(db, "tasks", task.id), patch);
}

export async function setSubtaskReviewers(task: TaskDoc, subtaskId: string, uids: string[]) {
  // Caller permission (admin / creator) is gated by the UI not rendering
  // the picker for anyone else. Phase 3 is client-enforced — see
  // setSubtaskAssignees.
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

export type ReviewState = "approve" | "question" | "reject" | "clear";

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
  // Gate: reviewers can't approve/question/reject until a completer has
  // marked the work done. Clearing a prior state is still allowed — the
  // reviewer might want to retract a ✓ they set before the row got
  // un-ticked in a re-review cycle.
  if (state !== "clear" && !target.done) {
    throw new Error(
      "Can't review this subtask yet — a completer hasn't marked it done.",
    );
  }
  // Gate: once a reviewer has signed off on this block (ticked their
  // signoff row done), their review cells for the block are frozen.
  // Retraction happens via admin unticking the signoff — not by editing
  // the underlying approvals. Other reviewers remain free to work at
  // their own pace.
  if (target.blockId && hasReviewerSignedOffBlock(task, target.blockId, uid)) {
    throw new Error(
      "You've already signed off on this block — approvals are locked. Ask an admin to retract your signoff first.",
    );
  }
  const db = getClientDb();
  const nextSubtasks = task.subtasks.map((s) => {
    if (s.id !== subtaskId) return s;
    // Mutually exclusive across the three arrays — remove uid from all,
    // then add to the chosen one (or to none, for "clear").
    const approved = s.approvedByReviewerUids.filter((u) => u !== uid);
    const questioned = s.questionedByReviewerUids.filter((u) => u !== uid);
    const rejected = s.rejectedByReviewerUids.filter((u) => u !== uid);
    if (state === "approve") approved.push(uid);
    if (state === "question") questioned.push(uid);
    if (state === "reject") rejected.push(uid);
    return {
      ...s,
      approvedByReviewerUids: approved,
      questionedByReviewerUids: questioned,
      rejectedByReviewerUids: rejected,
    };
  });
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: nextSubtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
  if (state === "reject") {
    queueActivity(batch, task.id, "subtask_rejected", uid, {
      subtaskId,
      title: target.title,
    });
  }
  await batch.commit();
}

/**
 * Resend a rejected subtask for review. Wipes every reviewer's state on
 * that subtask so the review slate is clean for the next cycle, appends
 * a `subtask_resubmitted` activity entry, and hands off to the existing
 * /send-for-review API route to email the reviewers. Row transitions
 * red → blue automatically (done=true + no reviewer state = "awaiting
 * review" resting state).
 *
 * Permission (client-enforced, mirrors the Phase 3 pattern): callable by
 * any listed assignee on the subtask, any completer if assigneeUids is
 * empty, or the task creator. Admins go through via the same path.
 */
export async function resubmitSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (target.rejectedByReviewerUids.length === 0) {
    throw new Error("Nothing to resend — this subtask isn't currently rejected.");
  }
  const isCreator = task.creatorUid === uid;
  const isAssigned = target.assigneeUids.includes(uid);
  const openToAnyCompleter =
    target.assigneeUids.length === 0 && task.completerUids.includes(uid);
  if (!isCreator && !isAssigned && !openToAnyCompleter) {
    throw new Error(
      "Only the people assigned to this subtask (or the task creator) can resend it for review.",
    );
  }
  const nextSubtasks = task.subtasks.map((s) =>
    s.id === subtaskId
      ? {
          ...s,
          approvedByReviewerUids: [],
          questionedByReviewerUids: [],
          rejectedByReviewerUids: [],
        }
      : s,
  );
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: nextSubtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "subtask_resubmitted", uid, {
    subtaskId,
    title: target.title,
  });
  await batch.commit();
  // Fire-and-forget email call — the reviewer-state wipe is the critical
  // bit; email failure is a soft-failure surfaced via the returned payload.
  try {
    const res = await fetch(`/api/tasks/${task.id}/send-for-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtaskId }),
    });
    if (!res.ok) {
      console.warn(
        `[resubmitSubtask] /send-for-review returned ${res.status}`,
      );
    }
  } catch (err) {
    console.warn("[resubmitSubtask] email dispatch failed", err);
  }
}

export async function renameSubtask(task: TaskDoc, subtaskId: string, title: string) {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Subtask title required");
  await patchSubtask(task, subtaskId, (s) => ({
    ...s,
    title: trimmed.slice(0, TASK_FIELD_LIMITS.subtaskTitle),
  }));
}

/**
 * Edit the per-subtask description — stable instructions from the task
 * creator. Empty string clears the description. Caller permission (admin /
 * creator / committee on committee tasks) is gated in the UI — same pattern
 * as task-level description edits. No activity log entry; descriptions
 * evolve freely during drafting and the noise isn't worth the audit value.
 */
export async function updateSubtaskDescription(
  task: TaskDoc,
  subtaskId: string,
  description: string,
) {
  await patchSubtask(task, subtaskId, (s) => ({
    ...s,
    description: description.slice(0, TASK_FIELD_LIMITS.subtaskDescription),
  }));
}

/**
 * Set or clear a subtask's due date. Pass `null` to remove. Intentionally
 * NOT enforced against task.dueDate — subtask deadlines are often firmer
 * than the task's aspirational deadline (e.g. publicity must land before
 * the event itself). UI-gated to admin/creator/committee-on-committee.
 */
export async function updateSubtaskDueDate(
  task: TaskDoc,
  subtaskId: string,
  dueDate: Date | null,
) {
  await patchSubtask(task, subtaskId, (s) => ({
    ...s,
    dueDate,
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

// ============================================================================
// Phase 3 — blocks, consensus lock-in, and seal/unseal.
// ============================================================================

/**
 * Append a new block to the end of `task.blocks`. Returns the new block id so
 * callers can assign freshly-created subtasks into it.
 */
export async function createBlock(task: TaskDoc, name: string): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Block name required");
  if (task.blocks.length >= TASK_FIELD_LIMITS.maxBlocks) {
    throw new Error(`Max ${TASK_FIELD_LIMITS.maxBlocks} blocks per task`);
  }
  const block: TaskBlock = {
    id: genId(),
    name: trimmed.slice(0, TASK_FIELD_LIMITS.blockName),
    order: task.blocks.length,
    sealState: "open",
    sealedAt: null,
    forceSealedByUid: null,
  };
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    blocks: [...task.blocks, block].map(serializeBlock),
    blockConsents: {
      ...task.blockConsents,
      [block.id]: { consentingCompleterUids: [] },
    },
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_created", uid, {
    blockId: block.id,
    name: block.name,
  });
  await batch.commit();
  return block.id;
}

export async function renameBlock(task: TaskDoc, blockId: string, name: string) {
  const db = getClientDb();
  const uid = actingUid();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Block name required");
  const existing = task.blocks.find((b) => b.id === blockId);
  if (!existing) throw new Error("Block not found");
  if (existing.name === trimmed) return;
  const nextName = trimmed.slice(0, TASK_FIELD_LIMITS.blockName);
  const blocks = task.blocks.map((b) =>
    b.id === blockId ? { ...b, name: nextName } : b,
  );
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    blocks: blocks.map(serializeBlock),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_renamed", uid, {
    blockId,
    name: nextName,
    previousName: existing.name,
  });
  await batch.commit();
}

export async function reorderBlocks(task: TaskDoc, orderedIds: string[]) {
  const db = getClientDb();
  const byId = new Map(task.blocks.map((b) => [b.id, b]));
  const next: TaskBlock[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const b = byId.get(id);
    if (b && !seen.has(id)) {
      next.push({ ...b, order: next.length });
      seen.add(id);
    }
  }
  // Preserve any blocks the caller left out (defensive — mirror reorderSubtasks).
  for (const b of task.blocks) {
    if (!seen.has(b.id)) next.push({ ...b, order: next.length });
  }
  await updateDoc(doc(db, "tasks", task.id), {
    blocks: next.map(serializeBlock),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Remove a block and rehome its subtasks to the ungrouped null block. Keeps
 * all subtask state (assignees, approvals, blockedBy refs) intact — a deleted
 * block is just the grouping being dropped, not the work. Also purges the
 * block's consent record.
 */
export async function deleteBlock(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const existing = task.blocks.find((b) => b.id === blockId);
  if (!existing) throw new Error("Block not found");
  const subtasks = task.subtasks.map((s) =>
    s.blockId === blockId ? { ...s, blockId: null } : s,
  );
  const blocks = task.blocks
    .filter((b) => b.id !== blockId)
    .map((b, i) => ({ ...b, order: i }));
  const restConsents: BlockConsentMap = {};
  for (const [k, v] of Object.entries(task.blockConsents)) {
    if (k !== blockId) restConsents[k] = v;
  }
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    blocks: blocks.map(serializeBlock),
    blockConsents: restConsents,
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_deleted", uid, {
    blockId,
    name: existing.name,
  });
  await batch.commit();
}

/**
 * Move a subtask between blocks (or to ungrouped). Clears lock-in consent on
 * both source and destination when they're open — the allocation picture has
 * changed on both sides.
 */
export async function setSubtaskBlock(
  task: TaskDoc,
  subtaskId: string,
  nextBlockId: string | null,
) {
  const db = getClientDb();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (nextBlockId && !task.blocks.some((b) => b.id === nextBlockId)) {
    throw new Error("Block not found");
  }
  if (target.blockId === nextBlockId) return;
  const subtasks = task.subtasks.map((s) =>
    s.id === subtaskId ? { ...s, blockId: nextBlockId } : s,
  );
  let consents = task.blockConsents;
  const afterSource = clearConsentIfOpen(task, target.blockId);
  if (afterSource) consents = afterSource;
  const intermediate: TaskDoc = { ...task, blockConsents: consents };
  const afterDest = clearConsentIfOpen(intermediate, nextBlockId);
  if (afterDest) consents = afterDest;
  const patch: Record<string, unknown> = {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  };
  if (consents !== task.blockConsents) patch.blockConsents = consents;
  await updateDoc(doc(db, "tasks", task.id), patch);
}

/**
 * Add or remove the current user from a block's consent list. If the addition
 * brings consent to N/N of `task.completerUids`, the block seals atomically
 * (sealState = sealed, sealedAt = serverTimestamp, activity entry). Caller
 * must be a listed completer on the task — client-enforced, rules-backed.
 *
 * Stage 1.5a semantic shift (2026-04-23): lock-in = allocation consensus,
 * not submission. Dropped the work-done gate so completers can lock in once
 * they're happy with who's doing what. Reviewer signoff rows no longer
 * spawn on seal — they spawn when completers press `sendBlockToReviewers`.
 */
export async function toggleBlockConsent(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  if (!task.completerUids.includes(uid)) {
    throw new Error("Only listed completers can lock in a block.");
  }
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error("Block not found");
  if (block.sealState === "sealed") {
    throw new Error("Block is already sealed.");
  }
  const current = task.blockConsents[blockId]?.consentingCompleterUids ?? [];
  const already = current.includes(uid);
  const nextConsenting = already
    ? current.filter((u) => u !== uid)
    : [...current, uid];
  const nextConsents: BlockConsentMap = {
    ...task.blockConsents,
    [blockId]: { consentingCompleterUids: nextConsenting },
  };

  const requiredSet = new Set(task.completerUids);
  const allConsented =
    !already &&
    task.completerUids.length > 0 &&
    task.completerUids.every((u) => nextConsenting.includes(u)) &&
    nextConsenting.every((u) => requiredSet.has(u));

  // Stage 1.5a gap-fix: the lock-in that SEALS the block (last consent
  // arriving) can't go through if any non-reviewer subtask still has
  // zero assignees — we'd seal an incomplete allocation. Earlier
  // consents pass through unchecked.
  if (allConsented) {
    const unassigned = task.subtasks.filter(
      (s) =>
        s.blockId === blockId &&
        s.roleHint !== "reviewer" &&
        s.assigneeUids.length === 0,
    );
    if (unassigned.length > 0) {
      const first = unassigned[0];
      const more =
        unassigned.length > 1 ? ` (+${unassigned.length - 1} more)` : "";
      throw new Error(
        `Can't lock in — "${first.title}" has no one assigned yet${more}.`,
      );
    }
  }

  const batch = writeBatch(db);
  const patch: Record<string, unknown> = {
    blockConsents: nextConsents,
    updatedAt: serverTimestamp(),
  };
  if (allConsented) {
    const blocks = task.blocks.map((b) =>
      b.id === blockId
        ? { ...b, sealState: "sealed" as const, sealedAt: new Date() }
        : b,
    );
    patch.blocks = blocks.map(serializeBlock);
    queueActivity(batch, task.id, "block_sealed", uid, {
      blockId,
      name: block.name,
    });
  }
  batch.update(doc(db, "tasks", task.id), patch);
  await batch.commit();
}

/**
 * Admin escape hatch — seal a block without waiting for unanimous consent.
 * Logged distinctly from the natural-consensus seal so the audit trail
 * preserves the "we moved despite missing sign-off" provenance.
 *
 * Stage 1.5a (2026-04-23): no longer spawns reviewer signoff rows. Seal now
 * means "allocation locked, work begins" — reviewer rows spawn via
 * `sendBlockToReviewers` once work is complete.
 */
export async function forceSealBlock(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error("Block not found");
  if (block.sealState === "sealed") return;
  const blocks = task.blocks.map((b) =>
    b.id === blockId
      ? {
          ...b,
          sealState: "sealed" as const,
          sealedAt: new Date(),
          forceSealedByUid: uid,
        }
      : b,
  );
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    blocks: blocks.map(serializeBlock),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_force_sealed", uid, {
    blockId,
    name: block.name,
  });
  await batch.commit();
}

/**
 * Completer-pressed handoff: spawn reviewer signoff rows for a sealed block
 * and log a `block_sent_to_reviewers` activity entry. Validates that every
 * non-reviewer subtask in the block is done, no signoff rows exist yet, and
 * the caller is a listed completer on the task.
 *
 * Stage 1.5a (2026-04-23) replaces the old "seal = spawn reviewers" flow.
 */
export async function sendBlockToReviewers(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  if (!task.completerUids.includes(uid)) {
    throw new Error("Only listed completers can send a block to reviewers.");
  }
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error("Block not found");
  if (block.sealState !== "sealed") {
    throw new Error("Lock in the block's allocation before sending to reviewers.");
  }
  const completionRows = task.subtasks.filter(
    (s) => s.blockId === blockId && s.roleHint !== "reviewer",
  );
  const outstanding = completionRows.filter((s) => !s.done);
  if (outstanding.length > 0) {
    const first = outstanding[0];
    const more = outstanding.length > 1 ? ` (+${outstanding.length - 1} more)` : "";
    throw new Error(
      `All tasks must be marked as complete before sending to reviewers — "${first.title}" isn't done yet${more}.`,
    );
  }
  const alreadySent = task.subtasks.some(
    (s) => s.blockId === blockId && s.roleHint === "reviewer",
  );
  if (alreadySent) {
    throw new Error("This block has already been sent to reviewers.");
  }
  const spawned = planReviewSpawn(task, blockId);
  const batch = writeBatch(db);
  const patch: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };
  if (spawned.length > 0) {
    const nextSubtasks = [...task.subtasks, ...spawned];
    patch.subtasks = nextSubtasks.map(serializeSubtask);
    patch.subtaskStats = computeSubtaskStats(nextSubtasks);
  }
  batch.update(doc(db, "tasks", task.id), patch);
  queueActivity(batch, task.id, "block_sent_to_reviewers", uid, {
    blockId,
    name: block.name,
    reviewerCount: spawned.length,
    reviewerUids: spawned.flatMap((s) => s.reviewerUids),
  });
  if (spawned.length > 0) {
    queueActivity(batch, task.id, "review_subtasks_spawned", uid, {
      blockId,
      name: block.name,
      count: spawned.length,
      reviewerUids: spawned.flatMap((s) => s.reviewerUids),
    });
  }
  await batch.commit();
}

/**
 * Admin escape hatch — re-open a sealed block. Clears sealedAt +
 * forceSealedByUid and resets the consent tally so the lock-in ritual can
 * run again. Auto-spawned review subtasks (PR 2) are deliberately kept —
 * they may carry partial approvals that shouldn't be thrown away.
 */
export async function unsealBlock(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error("Block not found");
  if (block.sealState === "open") return;
  const blocks = task.blocks.map((b) =>
    b.id === blockId
      ? { ...b, sealState: "open" as const, sealedAt: null, forceSealedByUid: null }
      : b,
  );
  const nextConsents: BlockConsentMap = {
    ...task.blockConsents,
    [blockId]: { consentingCompleterUids: [] },
  };
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    blocks: blocks.map(serializeBlock),
    blockConsents: nextConsents,
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_unsealed", uid, {
    blockId,
    name: block.name,
  });
  await batch.commit();
}

/**
 * Completer self-service: add own uid to a subtask's assigneeUids. Valid both
 * pre-seal AND post-seal — "my teammate is sick, I'm covering" is the
 * explicit post-seal path. Clears block lock-in consent when the block is
 * still open (the allocation picture moved).
 */
export async function selfAddToSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const uid = actingUid();
  if (!task.completerUids.includes(uid)) {
    throw new Error("Only listed completers can self-assign.");
  }
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (target.roleHint === "reviewer") {
    throw new Error(
      "This is a reviewer-signoff subtask — only the listed reviewer can complete it.",
    );
  }
  if (target.sealState === "sealed") {
    throw new Error("Subtask is sealed — an admin must unseal before roster changes.");
  }
  if (target.assigneeUids.includes(uid)) return;
  if (target.assigneeUids.length >= TASK_FIELD_LIMITS.maxAssigneesPerSubtask) {
    throw new Error(
      `Max ${TASK_FIELD_LIMITS.maxAssigneesPerSubtask} assignees per subtask`,
    );
  }
  const subtasks = task.subtasks.map((s) =>
    s.id === subtaskId ? { ...s, assigneeUids: [...s.assigneeUids, uid] } : s,
  );
  const patch: Record<string, unknown> = {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  };
  const consentsPatch = clearConsentIfOpen(task, target.blockId);
  if (consentsPatch) patch.blockConsents = consentsPatch;
  await updateDoc(doc(db, "tasks", task.id), patch);
}

/**
 * Completer self-service: remove own uid from a subtask's assigneeUids. Only
 * valid when the block is OPEN (pre-seal free-for-all). Post-seal the
 * completer must ask an admin to unseal, or a teammate to cover via
 * `selfAddToSubtask` — silent drops after lock-in would be the exact
 * regression the block system exists to prevent.
 */
export async function selfRemoveFromSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (target.sealState === "sealed") {
    throw new Error("Subtask is sealed — ask an admin to unseal before removing yourself.");
  }
  if (target.blockId) {
    const block = task.blocks.find((b) => b.id === target.blockId);
    if (block && block.sealState === "sealed") {
      throw new Error(
        "Block is sealed — ask an admin to unseal before removing yourself.",
      );
    }
  }
  if (!target.assigneeUids.includes(uid)) return;
  const subtasks = task.subtasks.map((s) =>
    s.id === subtaskId
      ? { ...s, assigneeUids: s.assigneeUids.filter((u) => u !== uid) }
      : s,
  );
  const patch: Record<string, unknown> = {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  };
  const consentsPatch = clearConsentIfOpen(task, target.blockId);
  if (consentsPatch) patch.blockConsents = consentsPatch;
  await updateDoc(doc(db, "tasks", task.id), patch);
}

/**
 * Admin subtask-level force-seal: freeze a single subtask's assignee list
 * without sealing the whole block. Useful when one row is firmly decided
 * while others are still in flux. Independent of the block's sealState.
 */
export async function forceSealSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (target.sealState === "sealed") return;
  const subtasks = task.subtasks.map((s) =>
    s.id === subtaskId
      ? { ...s, sealState: "sealed" as const, sealedAt: new Date() }
      : s,
  );
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "subtask_force_sealed", uid, {
    subtaskId,
    title: target.title,
  });
  await batch.commit();
}

export async function unsealSubtask(task: TaskDoc, subtaskId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const target = task.subtasks.find((s) => s.id === subtaskId);
  if (!target) throw new Error("Subtask not found");
  if (target.sealState === "open") return;
  const subtasks = task.subtasks.map((s) =>
    s.id === subtaskId
      ? { ...s, sealState: "open" as const, sealedAt: null }
      : s,
  );
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "subtask_unsealed", uid, {
    subtaskId,
    title: target.title,
  });
  await batch.commit();
}

/**
 * Idempotent catch-up for review rows on already-sealed blocks. Used by:
 *   1. The admin "Spawn missing reviewers" button for blocks sealed before
 *      the auto-spawn logic landed (PR 2 retrofits onto PR 1 data).
 *   2. Cases where a task's reviewer set grew after seal — new reviewers
 *      don't have a signoff row yet, this mutation fills them in.
 * No-op when every effective reviewer already has a signoff row in this
 * block. Safe to call on open blocks too (though only interesting on
 * sealed ones — on open blocks the normal seal will spawn them anyway).
 */
export async function ensureBlockReviewSubtasks(
  task: TaskDoc,
  blockId: string,
): Promise<number> {
  const db = getClientDb();
  const uid = actingUid();
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error("Block not found");
  const spawned = planReviewSpawn(task, blockId);
  if (spawned.length === 0) return 0;
  const nextSubtasks = [...task.subtasks, ...spawned];
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: nextSubtasks.map(serializeSubtask),
    subtaskStats: computeSubtaskStats(nextSubtasks),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "review_subtasks_spawned", uid, {
    blockId,
    name: block.name,
    count: spawned.length,
    reviewerUids: spawned.flatMap((s) => s.reviewerUids),
    catchUp: true,
  });
  await batch.commit();
  return spawned.length;
}

/**
 * Block-gate Apply: add every review-subtask id from this block to the
 * blockedBy of every subtask in the NEXT block. Scope is Option B per the
 * design call — gates the whole next block, not just its first subtask.
 * Idempotent — re-applying on already-gated rows is a no-op. Fails silently
 * if there's no next block or no review subtasks yet (UI disables the
 * button in those cases).
 */
export async function applyBlockGate(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const nextBlock = getNextBlock(task, blockId);
  if (!nextBlock) throw new Error("No block downstream to gate.");
  const reviewIds = getBlockReviewSubtaskIds(task, blockId);
  if (reviewIds.length === 0) {
    throw new Error("This block has no review subtasks to gate on yet.");
  }
  const reviewIdSet = new Set(reviewIds);
  const subtasks = task.subtasks.map((s) => {
    if (s.blockId !== nextBlock.id) return s;
    // Skip review subtasks inside the next block — reviewer signoffs
    // shouldn't be gated on upstream reviewers, only completion rows.
    if (s.roleHint === "reviewer") return s;
    const existing = new Set(s.blockedBy);
    let changed = false;
    for (const rid of reviewIdSet) {
      if (!existing.has(rid)) {
        existing.add(rid);
        changed = true;
      }
    }
    if (!changed) return s;
    const nextBlockedBy = Array.from(existing).slice(
      0,
      TASK_FIELD_LIMITS.maxBlockedBy,
    );
    return { ...s, blockedBy: nextBlockedBy };
  });
  const block = task.blocks.find((b) => b.id === blockId);
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_gate_applied", uid, {
    blockId,
    name: block?.name ?? "",
    nextBlockId: nextBlock.id,
    nextBlockName: nextBlock.name,
  });
  await batch.commit();
}

/**
 * Block-gate Clear: inverse of applyBlockGate. Strips this block's review
 * subtask ids from every next-block subtask's `blockedBy`. Leaves any
 * non-review blockedBy edges intact.
 */
export async function clearBlockGate(task: TaskDoc, blockId: string) {
  const db = getClientDb();
  const uid = actingUid();
  const nextBlock = getNextBlock(task, blockId);
  if (!nextBlock) return;
  const reviewIds = new Set(getBlockReviewSubtaskIds(task, blockId));
  if (reviewIds.size === 0) return;
  const subtasks = task.subtasks.map((s) => {
    if (s.blockId !== nextBlock.id) return s;
    if (!s.blockedBy.some((id) => reviewIds.has(id))) return s;
    return { ...s, blockedBy: s.blockedBy.filter((id) => !reviewIds.has(id)) };
  });
  const block = task.blocks.find((b) => b.id === blockId);
  const batch = writeBatch(db);
  batch.update(doc(db, "tasks", task.id), {
    subtasks: subtasks.map(serializeSubtask),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, task.id, "block_gate_cleared", uid, {
    blockId,
    name: block?.name ?? "",
    nextBlockId: nextBlock.id,
    nextBlockName: nextBlock.name,
  });
  await batch.commit();
}

/**
 * Consumer convenience — re-export so call sites don't have to dip into
 * the firestore layer for this derivation.
 */
export { getBlockConsensusState, getNextBlock, isBlockGateApplied };
