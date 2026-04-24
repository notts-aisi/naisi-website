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
  subtaskDescription: 2000,
  blockName: 60,
  tag: 40,
  maxSubtasks: 50,
  maxBlocks: 10,
  maxCompleters: 10,
  maxReviewers: 5,
  maxAssigneesPerSubtask: 10,
  maxReviewersPerSubtask: 5,
  maxBlockedBy: 10,
  maxTags: 8,
  commentBody: 2000,
} as const;

/**
 * Completion-phase container. A task's `subtasks` array stays flat; block
 * membership is carried on each subtask via `blockId`. `sealState` gates
 * the completer lock-in — pre-seal the completers can freely self-add or
 * -remove from subtasks in this block; post-seal they can only self-ADD
 * (cover-for-sick-teammate path). Auto-spawned review subtasks land on
 * `sealState === "sealed"`.
 */
export type BlockGatingMode = "previous" | "all-previous" | "none";

export type TaskBlock = {
  id: string;
  name: string;
  order: number;
  /** Block lifecycle:
   *   - "setup": task-setter phase — task reviewers (+ admin) are choosing
   *     which subtasks exist. Completers can't allocate themselves yet.
   *     Exit via `finalizeBlockSetup` (admin or task-level reviewer).
   *   - "open": allocation phase — roster being filled, consensus lock-in
   *     pending. Exit via consent tally reaching N/N (→ sealed).
   *   - "sealed": work phase — roster locked, subtasks immutable (admin
   *     override only), reviewer signoffs can be spawned.
   *
   * Existing blocks created before the task-setter phase PR have no
   * "setup" state — they normalize to "open" and keep the old behaviour. */
  sealState: "setup" | "open" | "sealed";
  sealedAt: Date | null;
  /** Admin UID who force-sealed this block, or null if it sealed via
   *  consensus. Purely informational — doesn't affect gating. */
  forceSealedByUid: string | null;
  /** Phase 3 / 1.9e: declarative upstream-deps mode. Drives whether this
   *  block's completion rows are blocked until upstream block(s) are
   *  complete. Defaults to "previous" for new blocks — gating works out
   *  of the box without admin action. Existing blocks (pre-migration)
   *  normalize to "previous". First block (order === 0) ignores this
   *  field — it has no upstream blocks. */
  gatingMode: BlockGatingMode;
};

export type BlockConsentMap = Record<string, { consentingCompleterUids: string[] }>;

export type Subtask = {
  id: string;
  title: string;
  /** Stable per-subtask instructions from the task creator — what's being
   *  asked for, suggested flow, acceptance cues. Distinct from the comment
   *  thread (which is dynamic back-and-forth). Empty string = not set.
   *  Markdown is not rendered; the popover shows plain text with preserved
   *  whitespace so formatting stays author-controlled. */
  description: string;
  /** Optional per-subtask due date. Independent of the task-level dueDate —
   *  often *firmer* than the task's aspirational deadline (e.g. the
   *  publicity post for an event must land days before the event itself).
   *  Not enforced against task.dueDate by design. */
  dueDate: Date | null;
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
   *  approvedByReviewerUids / questionedByReviewerUids / rejectedByReviewerUids
   *  — they're mutually exclusive states. */
  approvedByReviewerUids: string[];
  /** Reviewer UIDs who have flagged ❓ on this subtask — "I have a question,
   *  partially reviewed". Blocks their overall signoff (all-my-columns-✓)
   *  but not individual ticks on other subtasks. */
  questionedByReviewerUids: string[];
  /** Reviewer UIDs who have flagged ❌ on this subtask. Holds the row in a
   *  red "rejected" state until the completer re-does the work and the
   *  reviewer re-reviews. Wired into the 4-state approval popover in Phase 3
   *  PR 2; field lands here now so the data model only migrates once. */
  rejectedByReviewerUids: string[];
  /** Phase 3 block membership. `null` = ungrouped (task has no blocks, or
   *  subtask sits at the task root). Migration wraps every pre-Phase-3
   *  subtask into a single default block. */
  blockId: string | null;
  /** Subtask-level lock — admin-only toggle. Independent of block-level
   *  seal, so an admin can freeze an individual subtask's assignee list
   *  while the rest of the block stays open. */
  sealState: "open" | "sealed";
  sealedAt: Date | null;
  /** Auto-spawned review subtasks carry `roleHint: "reviewer"` so the UI
   *  can style them distinctly (pill / divider). `"completer"` is for
   *  template-level hints; `null` for regular user-added subtasks. */
  roleHint: "completer" | "reviewer" | null;
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
  /** Phase 3. Ordered completion phases. Empty array = legacy task with no
   *  blocks (all subtasks carry `blockId: null`). Migration inserts a single
   *  default block onto pre-Phase-3 tasks. */
  blocks: TaskBlock[];
  /** Per-block running tally of completers who've ticked "Lock in" on the
   *  current allocation. Cleared to `[]` on any roster change to a subtask
   *  in that block while the block is still open. On reaching N/N, the
   *  block seals and this record's usefulness ends (kept for audit). */
  blockConsents: BlockConsentMap;
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
  const rawRoleHint = s.roleHint;
  const roleHint: Subtask["roleHint"] =
    rawRoleHint === "completer" || rawRoleHint === "reviewer" ? rawRoleHint : null;
  const rawSealState = s.sealState;
  const sealState: Subtask["sealState"] =
    rawSealState === "sealed" ? "sealed" : "open";
  return {
    id,
    title,
    description: typeof s.description === "string" ? s.description : "",
    dueDate: tsToDate(s.dueDate),
    done: Boolean(s.done),
    doneAt: tsToDate(s.doneAt),
    doneByUid: typeof s.doneByUid === "string" ? s.doneByUid : null,
    assigneeUids: stringArray(s.assigneeUids),
    reviewerUids: stringArray(s.reviewerUids),
    blockedBy: stringArray(s.blockedBy),
    approvedByReviewerUids: stringArray(s.approvedByReviewerUids),
    questionedByReviewerUids: stringArray(s.questionedByReviewerUids),
    rejectedByReviewerUids: stringArray(s.rejectedByReviewerUids),
    blockId: typeof s.blockId === "string" ? s.blockId : null,
    sealState,
    sealedAt: tsToDate(s.sealedAt),
    roleHint,
  };
}

function normalizeBlock(raw: unknown): TaskBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Raw;
  const id = typeof b.id === "string" ? b.id : null;
  const name = typeof b.name === "string" ? b.name : null;
  if (!id || !name) return null;
  // Preserve backward-compat: unknown / missing sealState defaults to
  // "open" so existing blocks from before the task-setter phase keep
  // their old behaviour. Only new blocks created after this PR start
  // in "setup".
  const sealState: TaskBlock["sealState"] =
    b.sealState === "sealed"
      ? "sealed"
      : b.sealState === "setup"
        ? "setup"
        : "open";
  const order = typeof b.order === "number" ? b.order : 0;
  const rawMode = b.gatingMode;
  const gatingMode: BlockGatingMode =
    rawMode === "all-previous" || rawMode === "none"
      ? rawMode
      : "previous";
  return {
    id,
    name,
    order,
    sealState,
    sealedAt: tsToDate(b.sealedAt),
    forceSealedByUid:
      typeof b.forceSealedByUid === "string" ? b.forceSealedByUid : null,
    gatingMode,
  };
}

function normalizeBlockConsents(raw: unknown): BlockConsentMap {
  if (!raw || typeof raw !== "object") return {};
  const out: BlockConsentMap = {};
  for (const [blockId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const cb = value as Raw;
    out[blockId] = {
      consentingCompleterUids: stringArray(cb.consentingCompleterUids),
    };
  }
  return out;
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
  const rawBlocks = Array.isArray(data.blocks) ? (data.blocks as unknown[]) : [];
  const blocks = rawBlocks
    .map(normalizeBlock)
    .filter((b): b is TaskBlock => b !== null)
    .sort((a, b) => a.order - b.order);
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
    blocks,
    blockConsents: normalizeBlockConsents(data.blockConsents),
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
 * Effective reviewer set for a given subtask. Stage 2 (2026-04-24):
 * dropped the task-level fallback — reviewers must explicitly claim
 * individual subtasks via `+ Review` (the self-service affordance in
 * `SubtaskRow`). If `subtask.reviewerUids` is empty, the subtask has no
 * review gate at all (green-when-done).
 *
 * Second parameter retained for backward-compat with existing callers;
 * value is unused.
 */
export function effectiveReviewerUids(
  subtask: Subtask,
  _taskReviewerUids: string[] = [],
): string[] {
  return subtask.reviewerUids;
}

export type SubtaskApprovalStatus = {
  /** Reviewers expected to weigh in on this subtask. */
  required: string[];
  approved: string[];
  questioned: string[];
  /** Reviewers who've placed ❌ — outranks ? and ✓ for row state. Re-review
   *  clears this (completer re-ticks → reviewer slate resets). */
  rejected: string[];
  /** Every required reviewer has placed ✓ AND nobody has rejected. */
  fullyApproved: boolean;
  /** At least one required reviewer has placed ✓ — the per-subtask
   *  threshold for blockedBy resolution. Still false if any reviewer has
   *  rejected, because a rejection holds the row until re-review. */
  hasAnyApproval: boolean;
  /** At least one reviewer has an outstanding ❓. */
  hasOutstandingQuestion: boolean;
  /** At least one reviewer has placed ❌. */
  hasRejection: boolean;
};

export function getSubtaskApprovalStatus(
  subtask: Subtask,
  taskReviewerUids: string[],
): SubtaskApprovalStatus {
  const required = effectiveReviewerUids(subtask, taskReviewerUids);
  const requiredSet = new Set(required);
  const approved = subtask.approvedByReviewerUids.filter((u) => requiredSet.has(u));
  const questioned = subtask.questionedByReviewerUids.filter((u) => requiredSet.has(u));
  const rejected = subtask.rejectedByReviewerUids.filter((u) => requiredSet.has(u));
  const hasRejection = rejected.length > 0;
  return {
    required,
    approved,
    questioned,
    rejected,
    fullyApproved:
      required.length > 0 && approved.length === required.length && !hasRejection,
    hasAnyApproval: approved.length > 0 && !hasRejection,
    hasOutstandingQuestion: questioned.length > 0,
    hasRejection,
  };
}

/**
 * Block-level gating check: is the block's upstream dependency unmet?
 * Drives the Phase 3 / 1.9e declarative gating dropdown. First block
 * (order === 0) is always ungated — nothing upstream. `none` mode never
 * gates. `previous` gates on the immediate upstream block. `all-previous`
 * gates on every block with a lower order.
 */
export function isBlockGatedByUpstream(
  task: TaskDoc,
  block: TaskBlock,
): boolean {
  if (block.gatingMode === "none") return false;
  if (block.order === 0) return false;
  const upstream = task.blocks.filter((b) => b.order < block.order);
  if (upstream.length === 0) return false;
  if (block.gatingMode === "previous") {
    let previous: TaskBlock | null = null;
    for (const b of upstream) {
      if (!previous || b.order > previous.order) previous = b;
    }
    if (!previous) return false;
    return getBlockPhase(task, previous) !== "complete";
  }
  // all-previous
  return upstream.some((b) => getBlockPhase(task, b) !== "complete");
}

/**
 * A subtask is tickable only when its parent block's upstream gating is
 * satisfied AND every `blockedBy`-reference resolves to a sibling that is
 * `done: true`. Block-level gating 2026-04-23 (1.9e) — previously the
 * only gate was `blockedBy`. Unknown blocker ids are fail-safe blocked.
 *
 * Accepts either the full `TaskDoc` (preferred — enables block-gating
 * check) or just `siblings` (legacy callers; degrades to subtask-level
 * `blockedBy` only).
 */
export function isSubtaskBlocked(
  subtask: Subtask,
  taskOrSiblings: TaskDoc | Subtask[],
  _taskReviewerUids: string[] = [],
): boolean {
  const siblings = Array.isArray(taskOrSiblings)
    ? taskOrSiblings
    : taskOrSiblings.subtasks;
  const task = Array.isArray(taskOrSiblings) ? null : taskOrSiblings;
  if (task && subtask.blockId) {
    const parentBlock = task.blocks.find((b) => b.id === subtask.blockId);
    if (parentBlock && isBlockGatedByUpstream(task, parentBlock)) return true;
  }
  if (subtask.blockedBy.length === 0) return false;
  const byId = new Map(siblings.map((s) => [s.id, s]));
  return subtask.blockedBy.some((id) => {
    const blocker = byId.get(id);
    if (!blocker) return true;
    if (!blocker.done) return true;
    return false;
  });
}

export type RowState = "neutral" | "blue" | "orange" | "green" | "red";

/**
 * Derives the colour band for a subtask row given its current state + whether
 * a sent_for_review has already fired targeting it. Rules (first match wins):
 *   - orange: any required reviewer has placed ❌ (rejection — softened from
 *             red 2026-04-24 per user direction: "humane tone, rejection
 *             feels less alarming as orange"). Auto-unticks on reject so
 *             completers see it as "redo this" rather than a done-but-bad
 *             state.
 *   - neutral: not done yet AND no rejection pending
 *   - orange: any outstanding ❓, OR sent-for-review pending with approvals incomplete
 *   - green: fully approved, OR done-with-no-reviewers
 *   - blue: done but approvals outstanding and no ❓ yet (resting state)
 */
export function subtaskRowState(
  subtask: Subtask,
  taskReviewerUids: string[],
  sentForReviewPending: boolean,
): RowState {
  const status = getSubtaskApprovalStatus(subtask, taskReviewerUids);
  if (status.hasRejection) return "orange";
  if (!subtask.done) return "neutral";
  if (status.hasOutstandingQuestion) return "orange";
  if (status.required.length === 0) return "green"; // no review gate
  if (status.fullyApproved) return "green";
  if (sentForReviewPending) return "orange";
  return "blue";
}

/**
 * Subtasks grouped for render. Each block gets:
 *   - `completion`: the work subtasks (non-reviewer-hint)
 *   - `signoffs`: the auto-spawned reviewer rows (roleHint === "reviewer")
 *
 * Rendered as two visually-distinct containers so the review phase reads
 * as its own thing, not as trailing rows inside the completion block.
 * Ungrouped subtasks (`blockId === null`) land at the end with `block: null`
 * and any reviewer-hint ones sit with them in `completion` (shouldn't
 * happen in practice — review rows are always spawned into a block).
 */
export function groupSubtasksByBlock(
  task: TaskDoc,
): Array<{ block: TaskBlock | null; completion: Subtask[]; signoffs: Subtask[] }> {
  const completionByBlock = new Map<string | null, Subtask[]>();
  const signoffByBlock = new Map<string, Subtask[]>();
  for (const s of task.subtasks) {
    const key = s.blockId ?? null;
    if (s.roleHint === "reviewer" && key !== null) {
      const list = signoffByBlock.get(key) ?? [];
      list.push(s);
      signoffByBlock.set(key, list);
    } else {
      const list = completionByBlock.get(key) ?? [];
      list.push(s);
      completionByBlock.set(key, list);
    }
  }
  const out: Array<{ block: TaskBlock | null; completion: Subtask[]; signoffs: Subtask[] }> = [];
  for (const block of task.blocks) {
    out.push({
      block,
      completion: completionByBlock.get(block.id) ?? [],
      signoffs: signoffByBlock.get(block.id) ?? [],
    });
  }
  const ungrouped = completionByBlock.get(null) ?? [];
  if (ungrouped.length > 0) {
    out.push({ block: null, completion: ungrouped, signoffs: [] });
  }
  return out;
}

/**
 * Phase of a block in the Stage 1.9 lifecycle:
 *   - `allocating`: block is open, completers deciding who does what.
 *     Colour: red (attention needed, allocation incomplete).
 *   - `in-progress`: block sealed (roster locked), work underway, no
 *     signoff rows yet. Colour: orange.
 *   - `reviewing`: signoff rows spawned (Notify pressed), not yet all done.
 *     Colour: yellow.
 *   - `complete`: every signoff row is ticked done — block accepted.
 *     Colour: green.
 */
export type BlockPhase = "setup" | "allocating" | "in-progress" | "reviewing" | "complete";

export function getBlockPhase(task: TaskDoc, block: TaskBlock): BlockPhase {
  if (block.sealState === "setup") return "setup";
  if (block.sealState !== "sealed") return "allocating";
  const signoffs = task.subtasks.filter(
    (s) => s.blockId === block.id && s.roleHint === "reviewer",
  );
  const completionRows = task.subtasks.filter(
    (s) => s.blockId === block.id && s.roleHint !== "reviewer",
  );
  const allCompletionDone =
    completionRows.length === 0 || completionRows.every((s) => s.done);
  if (signoffs.length === 0) {
    // No signoff rows yet. Two cases:
    //  (a) no reviewers claimed on any subtask → no review gate ever,
    //      go green as soon as every completion row is ticked done.
    //  (b) reviewers have claimed scope but Notify hasn't been pressed —
    //      stay in-progress so the "Notify reviewers" button surfaces.
    const hasAnyReviewerClaim = completionRows.some(
      (s) => s.reviewerUids.length > 0,
    );
    if (!hasAnyReviewerClaim && allCompletionDone) return "complete";
    return "in-progress";
  }
  // Signoffs exist (Notify has been pressed). A rejection auto-unticks
  // its subtask → if any completion row isn't done, drop back to
  // "in-progress" (orange) even with signoff rows spawned.
  if (!allCompletionDone) return "in-progress";
  if (signoffs.every((s) => s.done)) return "complete";
  return "reviewing";
}

/**
 * Successor lookup: the block with the smallest `order` strictly greater than
 * the given block's. Returns null when the given block is the last one, when
 * no block with that id exists, or when the task has fewer than two blocks.
 * Used by the block-gate button to know what to gate on.
 */
export function getNextBlock(task: TaskDoc, blockId: string): TaskBlock | null {
  const current = task.blocks.find((b) => b.id === blockId);
  if (!current) return null;
  let next: TaskBlock | null = null;
  for (const b of task.blocks) {
    if (b.order <= current.order) continue;
    if (!next || b.order < next.order) next = b;
  }
  return next;
}

/**
 * The review subtasks auto-spawned inside a block on seal. Identified by
 * `roleHint === "reviewer"` + matching blockId. Used by block-gate apply
 * to know what to add to downstream subtasks' blockedBy.
 */
export function getBlockReviewSubtaskIds(task: TaskDoc, blockId: string): string[] {
  return task.subtasks
    .filter((s) => s.blockId === blockId && s.roleHint === "reviewer")
    .map((s) => s.id);
}

/**
 * Gate state for the "Gate next block on reviews" button: true when every
 * subtask in the next block contains every review-subtask id from this
 * block in its `blockedBy`. Used to drive the Apply/Clear toggle.
 */
export function isBlockGateApplied(task: TaskDoc, blockId: string): boolean {
  const nextBlock = getNextBlock(task, blockId);
  if (!nextBlock) return false;
  const reviewIds = getBlockReviewSubtaskIds(task, blockId);
  if (reviewIds.length === 0) return false;
  const nextSubtasks = task.subtasks.filter((s) => s.blockId === nextBlock.id);
  if (nextSubtasks.length === 0) return false;
  return nextSubtasks.every((s) =>
    reviewIds.every((rid) => s.blockedBy.includes(rid)),
  );
}

export type BlockConsensusState = {
  /** Completers whose consent is required for this block to seal — mirrors
   *  `task.completerUids` at the moment of evaluation. Zero-length means
   *  "no completers on task" → vacuously sealed. */
  required: string[];
  consenting: string[];
  /** `required.length === 0 || consenting ⊇ required`. Consumers use this
   *  to drive the "Lock in" button → seal transition. */
  allConsented: boolean;
};

export function getBlockConsensusState(
  task: TaskDoc,
  blockId: string,
): BlockConsensusState {
  const required = task.completerUids;
  const record = task.blockConsents[blockId];
  const consenting = (record?.consentingCompleterUids ?? []).filter((u) =>
    required.includes(u),
  );
  const allConsented = required.length === 0
    ? true
    : required.every((u) => consenting.includes(u));
  return { required, consenting, allConsented };
}

/**
 * Effective reviewer set for a block: union of every subtask.reviewerUids on
 * non-review-hint subtasks inside this block. Falls back to task-level
 * reviewerUids if the union is empty. Used by the auto-spawn logic (PR 2)
 * and by the block-gate button enablement.
 */
export function getBlockEffectiveReviewerUids(
  task: TaskDoc,
  blockId: string,
): string[] {
  const out = new Set<string>();
  for (const s of task.subtasks) {
    if (s.blockId !== blockId) continue;
    if (s.roleHint === "reviewer") continue;
    for (const u of s.reviewerUids) out.add(u);
  }
  if (out.size > 0) return Array.from(out);
  return [...task.reviewerUids];
}

/**
 * Gating for a reviewer-signoff subtask (`roleHint: "reviewer"`). The
 * reviewer can only tick their signoff once they've approved every
 * completion row in the same block that they're required to review.
 *
 * Returns the specific block-mates that are holding the signoff back —
 * each entry explains why (`not-done`, `not-approved-by-me`, or
 * `rejected-by-me` for sanity). Empty array means the signoff is
 * unlocked for this reviewer.
 *
 * Ignores other reviewer-hint rows in the same block — those are peer
 * signoffs, not work to approve.
 */
export type ReviewerSignoffBlocker = {
  id: string;
  title: string;
  reason: "not-done" | "not-approved-by-me" | "rejected-by-me";
};

export function getReviewerSignoffBlockers(
  task: TaskDoc,
  signoffSubtask: Subtask,
  reviewerUid: string,
): ReviewerSignoffBlocker[] {
  if (signoffSubtask.roleHint !== "reviewer") return [];
  if (signoffSubtask.blockId === null) return [];
  const out: ReviewerSignoffBlocker[] = [];
  for (const s of task.subtasks) {
    if (s.id === signoffSubtask.id) continue;
    if (s.blockId !== signoffSubtask.blockId) continue;
    if (s.roleHint === "reviewer") continue;
    const effective = effectiveReviewerUids(s, task.reviewerUids);
    if (!effective.includes(reviewerUid)) continue;
    if (s.rejectedByReviewerUids.includes(reviewerUid)) {
      out.push({ id: s.id, title: s.title, reason: "rejected-by-me" });
      continue;
    }
    if (!s.done) {
      out.push({ id: s.id, title: s.title, reason: "not-done" });
      continue;
    }
    if (!s.approvedByReviewerUids.includes(reviewerUid)) {
      out.push({ id: s.id, title: s.title, reason: "not-approved-by-me" });
    }
  }
  return out;
}

/**
 * True when the given reviewer has already ticked their signoff row for
 * the given block. Used to lock their per-subtask review cells in that
 * block — once a reviewer has signed off, their approvals / rejections /
 * questions on the block are frozen. Other reviewers stay independent.
 */
export function hasReviewerSignedOffBlock(
  task: TaskDoc,
  blockId: string,
  reviewerUid: string,
): boolean {
  return task.subtasks.some(
    (s) =>
      s.blockId === blockId &&
      s.roleHint === "reviewer" &&
      s.reviewerUids.includes(reviewerUid) &&
      s.done,
  );
}

/**
 * Per-reviewer global coverage across the whole task: how many of the
 * subtasks this reviewer is required on they've approved. Used by the
 * final-signoff confirmation popup — when `approved === required - 1` and
 * the reviewer is about to place their last ✓, we pop a confirm to make
 * "completely signed off" feel intentional rather than accidental.
 */
export function getReviewerGlobalCoverage(
  task: TaskDoc,
  reviewerUid: string,
): { approved: number; required: number } {
  let approved = 0;
  let required = 0;
  for (const s of task.subtasks) {
    const effective = effectiveReviewerUids(s, task.reviewerUids);
    if (!effective.includes(reviewerUid)) continue;
    required += 1;
    // Reviewer-signoff rows (auto-spawned on block seal): ticking `done`
    // IS the approval — no separate matrix cell. Count the tick as an
    // approval so global coverage is consistent with the matrix-based rows.
    if (s.roleHint === "reviewer" && s.done) {
      approved += 1;
      continue;
    }
    if (s.approvedByReviewerUids.includes(reviewerUid)) approved += 1;
  }
  return { approved, required };
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
    const status = getSubtaskApprovalStatus(s, task.reviewerUids);
    if (status.hasRejection) {
      return {
        ok: false,
        reason: `Subtask "${s.title}" has an outstanding rejection — re-do and re-review before closing.`,
      };
    }
    if (!s.done) {
      return { ok: false, reason: `Subtask "${s.title}" is not marked done yet.` };
    }
    if (status.required.length > 0 && !status.hasAnyApproval) {
      return {
        ok: false,
        reason: `Subtask "${s.title}" is waiting on at least one reviewer approval.`,
      };
    }
  }
  // Global coverage — every task-level reviewer has signed off ≥1
  // subtask somewhere. Counts either a ✓ in the matrix OR a ticked-done
  // reviewer-signoff row (auto-spawned on block seal).
  for (const reviewerUid of task.reviewerUids) {
    const ticked = task.subtasks.some((s) => {
      if (s.approvedByReviewerUids.includes(reviewerUid)) return true;
      if (
        s.roleHint === "reviewer" &&
        s.done &&
        s.reviewerUids.includes(reviewerUid)
      ) {
        return true;
      }
      return false;
    });
    if (!ticked) {
      return {
        ok: false,
        reason: "A listed reviewer hasn't signed off on anything yet.",
      };
    }
  }
  return { ok: true, reason: null };
}
