"use client";

import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  TASK_FIELD_LIMITS,
  getBlockPhase,
  groupSubtasksByBlock,
  type BlockPhase,
  type Subtask,
  type TaskBlock,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import type { Role } from "@/lib/firebase/session";
import {
  addSubtask,
  createBlock,
  reorderSubtasks,
  sendBlockToReviewers,
} from "../taskMutations";
import BlockHeader from "./BlockHeader";
import SubtaskRow from "./SubtaskRow";

type Props = {
  task: TaskDoc;
  users: UserDoc[];
  viewerUid: string;
  viewerRole: Role;
  canEdit: boolean;
  canEditStructure: boolean;
  /** Admin + task-creator only. Gates rewrites of subtask `assigneeUids` /
   *  `reviewerUids` rosters via the pickers. Stricter than
   *  `canEditStructure` — a non-creator committee member can rename/delete
   *  blocks and manage block structure, but cannot edit who's assigned
   *  to individual subtasks. Completers manage their own subtask
   *  membership via the +Me / −Me buttons. */
  canEditRoster: boolean;
  /** Whether the viewer sees the per-reviewer approval columns. */
  showMatrix: boolean;
  /** Set of subtask IDs that have an in-flight sent_for_review (derived from
   *  the activity feed in the parent). Empty set means "no review pending
   *  anywhere". */
  pendingReviewSubtaskIds: Set<string>;
};

export default function SubtaskList({
  task,
  users,
  viewerUid,
  viewerRole,
  canEdit,
  canEditStructure,
  canEditRoster,
  showMatrix,
  pendingReviewSubtaskIds,
}: Props) {
  const isAdmin = viewerRole === "admin";
  const isTaskReviewer = task.reviewerUids.includes(viewerUid);
  const isCreator = task.creatorUid === viewerUid;
  // Task-setter phase: during a block's "setup" state, only admin + task-
  // level reviewers + creator can add subtasks. Committee-at-large and
  // completers are deliberately locked out — the phase exists to give
  // reviewers (or the task owner) a clean window to define the work.
  // Creator-fallback covers reviewer-less tasks so they aren't stuck.
  const canAddInSetup = isAdmin || isTaskReviewer || isCreator;

  // `activationConstraint` prevents accidental drags when the user is just
  // clicking checkboxes or text inputs inside a row.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const groups = groupSubtasksByBlock(task);
  const hasBlocks = task.blocks.length > 0;

  /**
   * Per-group drag reorder. We rebuild the full subtask order by keeping
   * every other group's subtasks in their current relative order and
   * splicing the dragged group's new order in place. `reorderSubtasks`
   * then rewrites the flat subtasks array — blockId is carried on each
   * subtask so block membership is preserved. Cross-block drag is not
   * supported here; use the "Move to block" control in the subtask Edit
   * panel instead.
   */
  function makeDragEndHandler(groupSubtaskIds: string[]) {
    return async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = groupSubtaskIds.indexOf(String(active.id));
      const newIndex = groupSubtaskIds.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      const nextGroup = [...groupSubtaskIds];
      nextGroup.splice(oldIndex, 1);
      nextGroup.splice(newIndex, 0, String(active.id));
      const nextGroupSet = new Set(nextGroup);
      const fullOrder: string[] = [];
      for (const g of groups) {
        // Only completion rows are sortable — if the drag is targeting this
        // group's completion list, splice in the new order; otherwise keep
        // the existing relative order. Signoff rows always append after
        // their block's completion rows in the flat array.
        if (g.completion.some((s) => nextGroupSet.has(s.id))) {
          fullOrder.push(...nextGroup);
        } else {
          for (const s of g.completion) fullOrder.push(s.id);
        }
        for (const s of g.signoffs) fullOrder.push(s.id);
      }
      try {
        await reorderSubtasks(task, fullOrder);
      } catch (err) {
        console.error(err);
      }
    };
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {task.subtasks.length === 0 && !canEdit && (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
          No subtasks.
        </p>
      )}

      {groups.map((group) => {
        // Stage 1.9a block-phase colour scheme:
        //   allocating (open)    → red    (attention: allocation incomplete)
        //   in-progress (sealed) → orange (work under way)
        //   reviewing            → yellow (handed to reviewers, not done)
        //   complete             → green  (all reviewers signed off)
        const phase: BlockPhase | null = group.block
          ? getBlockPhase(task, group.block)
          : null;
        const phasePalette = phase ? BLOCK_PHASE_PALETTE[phase] : null;
        const blockContainerStyle: React.CSSProperties = phasePalette
          ? {
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              background: phasePalette.bg,
              border: `1px solid ${phasePalette.border}`,
              borderLeftWidth: "3px",
              borderRadius: "var(--radius-md)",
            }
          : {
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            };
        const signoffRows = group.signoffs;
        return (
          <div
            key={group.block ? group.block.id : "__ungrouped__"}
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
          >
            <div style={blockContainerStyle}>
              {group.block && (
                <BlockHeader
                  task={task}
                  block={group.block}
                  viewerUid={viewerUid}
                  isAdmin={isAdmin}
                  isCreator={isCreator}
                  canEditStructure={canEditStructure}
                />
              )}
              {group.completion.length === 0 && group.block && canEdit && (
                <p
                  style={{
                    color: "var(--color-text-muted)",
                    fontSize: "var(--text-xs)",
                    fontStyle: "italic",
                    padding: "0 var(--space-2)",
                  }}
                >
                  No subtasks in this block yet.
                </p>
              )}
              {canEdit && group.completion.length > 0 ? (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={makeDragEndHandler(group.completion.map((s) => s.id))}
                >
                  <SortableContext
                    items={group.completion.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {group.completion.map((s) => (
                      <SortableSubtaskRow key={s.id} id={s.id}>
                        {(handle) => (
                          <SubtaskRow
                            task={task}
                            subtask={s}
                            users={users}
                            viewerUid={viewerUid}
                            isAdmin={isAdmin}
                            canEditRoster={canEditRoster}
                            canEdit={canEdit}
                            canEditStructure={canEditStructure}
                            showMatrix={showMatrix}
                            isReviewPending={pendingReviewSubtaskIds.has(s.id)}
                            dragHandle={handle}
                          />
                        )}
                      </SortableSubtaskRow>
                    ))}
                  </SortableContext>
                </DndContext>
              ) : (
                group.completion.map((s) => (
                  <SubtaskRow
                    key={s.id}
                    task={task}
                    subtask={s}
                    users={users}
                    viewerUid={viewerUid}
                    isAdmin={isAdmin}
                    canEditRoster={canEditRoster}
                    canEdit={canEdit}
                    canEditStructure={canEditStructure}
                    showMatrix={showMatrix}
                    isReviewPending={pendingReviewSubtaskIds.has(s.id)}
                  />
                ))
              )}
              {/* Subtask-add gating by block phase:
                    - setup: admin + task-level reviewers only (task-setter phase)
                    - sealed: admin only (Stage 2 tightening — post-lock-in,
                      everyone else files a comment instead so dependency
                      wiring stays intact)
                    - open / ungrouped: any completer/reviewer with canEdit */}
              {canEdit &&
                task.subtasks.length < TASK_FIELD_LIMITS.maxSubtasks &&
                (group.block?.sealState === "setup"
                  ? canAddInSetup
                  : group.block?.sealState === "sealed"
                    ? isAdmin
                    : true) && (
                  <InlineAddSubtask task={task} blockId={group.block?.id ?? null} />
                )}
              {group.block &&
                group.block.sealState === "sealed" &&
                signoffRows.length === 0 &&
                group.completion.length > 0 && (
                  <NotifyReviewersButton
                    task={task}
                    blockId={group.block.id}
                    completion={group.completion}
                    viewerIsCompleter={task.completerUids.includes(viewerUid)}
                    viewerIsAdmin={isAdmin}
                    viewerIsCreator={isCreator}
                  />
                )}
            </div>
            {group.block && signoffRows.length > 0 && (
              <SignoffPhase
                task={task}
                block={group.block}
                signoffs={signoffRows}
                users={users}
                viewerUid={viewerUid}
                isAdmin={isAdmin}
                canEdit={canEdit}
                showMatrix={showMatrix}
                pendingReviewSubtaskIds={pendingReviewSubtaskIds}
                canEditStructure={canEditStructure}
                canEditRoster={canEditRoster}
              />
            )}
          </div>
        );
      })}

      {canEditStructure && task.blocks.length < TASK_FIELD_LIMITS.maxBlocks && (
        <InlineAddBlock task={task} hasBlocks={hasBlocks} />
      )}
    </div>
  );
}

/**
 * "Send block to reviewers" button at the bottom of the completion block.
 * Only rendered pre-Notify (no signoff rows yet) and when the block has at
 * least one completion subtask. Greyed with helper text until every
 * non-reviewer subtask in the block is done. Press spawns reviewer signoff
 * rows server-side and logs a `block_sent_to_reviewers` activity entry.
 *
 * Visible to listed completers + admin + creator. Stage 1.9a originally
 * gated this to completers only — widened 2026-04-25 because reviewer-less
 * test tasks (admin testing alone) had no path to advance the block, and
 * creator-fallback mirrors the same widening on `finalizeBlockSetup`.
 */
function NotifyReviewersButton({
  task,
  blockId,
  completion,
  viewerIsCompleter,
  viewerIsAdmin,
  viewerIsCreator,
}: {
  task: TaskDoc;
  blockId: string;
  completion: Subtask[];
  viewerIsCompleter: boolean;
  viewerIsAdmin: boolean;
  viewerIsCreator: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (!viewerIsCompleter && !viewerIsAdmin && !viewerIsCreator) return null;
  const outstanding = completion.filter((s) => !s.done);
  const allDone = outstanding.length === 0;
  // Admin / creator can press regardless of completion state — they get a
  // confirm popup if there are outstanding subtasks. Same escape-hatch
  // pattern as `forceSealBlock` for the lock-in gate. Completers must
  // wait for everything to be ticked.
  const canOverride = viewerIsAdmin || viewerIsCreator;
  const canSend = allDone || canOverride;
  const helperText = allDone
    ? "All tasks complete — ready to send to reviewers."
    : canOverride
      ? `${outstanding.length} subtask${outstanding.length === 1 ? "" : "s"} not yet done — admin/creator can force-send anyway.`
      : "All tasks must be marked as complete before sending to reviewers.";

  async function handleSend() {
    if (!canSend || busy) return;
    if (!allDone && canOverride) {
      const ok = window.confirm(
        `Send "${task.subtasks.find((s) => s.blockId === blockId)?.title ?? "this block"}" to reviewers with ${outstanding.length} subtask${outstanding.length === 1 ? "" : "s"} still outstanding? The signoff rows will spawn anyway — admin/creator override.`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await sendBlockToReviewers(task, blockId);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        paddingTop: "var(--space-2)",
        borderTop: "1px dashed var(--color-border)",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: "var(--text-xs)",
          color: canSend ? "var(--color-text)" : "var(--color-text-muted)",
        }}
      >
        {helperText}
      </span>
      <button
        type="button"
        onClick={handleSend}
        disabled={!canSend || busy}
        style={{
          padding: "0.35rem 0.85rem",
          background: canSend
            ? "var(--color-accent-soft)"
            : "var(--color-bg-elevated)",
          color: canSend ? "var(--color-accent)" : "var(--color-text-muted)",
          border: canSend ? "none" : "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm, 4px)",
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          cursor: !canSend || busy ? "not-allowed" : "pointer",
          opacity: !canSend ? 0.6 : 1,
        }}
        title={
          canSend
            ? "Spawn reviewer signoff rows and kick off the review phase."
            : helperText
        }
      >
        {busy ? "Sending…" : "Notify reviewers"}
      </button>
    </div>
  );
}

/**
 * "Reviews for {block}" container — visually distinct from the completion
 * block above it. Warm-toned to match the reviewer pill palette. Contains
 * the auto-spawned reviewer-signoff rows plus the block-gate toggle.
 *
 * Sits below its parent block and stays pinned there regardless of how
 * many completion rows get added upstream, because completion and signoff
 * rows are partitioned by `groupSubtasksByBlock` now.
 */
function SignoffPhase({
  task,
  block,
  signoffs,
  users,
  viewerUid,
  isAdmin,
  canEdit,
  showMatrix,
  pendingReviewSubtaskIds,
  canEditStructure,
  canEditRoster,
}: {
  task: TaskDoc;
  block: TaskBlock;
  signoffs: Subtask[];
  users: UserDoc[];
  viewerUid: string;
  isAdmin: boolean;
  canEdit: boolean;
  showMatrix: boolean;
  pendingReviewSubtaskIds: Set<string>;
  canEditStructure: boolean;
  canEditRoster: boolean;
}) {
  const allSignedOff = signoffs.length > 0 && signoffs.every((s) => s.done);
  // Stage 1.9a: SignoffPhase container mirrors the parent block's phase
  // colours — yellow while reviews are outstanding, green once every
  // reviewer has signed off.
  const signoffPalette = allSignedOff
    ? BLOCK_PHASE_PALETTE.complete
    : BLOCK_PHASE_PALETTE.reviewing;
  const signoffBg = signoffPalette.bg;
  const signoffBorder = signoffPalette.border;
  const signoffLabel = signoffPalette.labelColor;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        background: signoffBg,
        border: `1px solid ${signoffBorder}`,
        borderLeftWidth: "3px",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 700,
          color: signoffLabel,
        }}
      >
        <span>Reviews for &ldquo;{block.name}&rdquo;</span>
        <span
          style={{
            fontSize: "var(--text-xs)",
            textTransform: "none",
            letterSpacing: "normal",
            fontWeight: 500,
            color: "var(--color-text-muted)",
          }}
        >
          ({signoffs.filter((s) => s.done).length}/{signoffs.length} signed off)
        </span>
      </div>
      {signoffs.map((s) => (
        <SubtaskRow
          key={s.id}
          task={task}
          subtask={s}
          users={users}
          viewerUid={viewerUid}
          isAdmin={isAdmin}
          canEditRoster={canEditRoster}
          canEdit={canEdit}
          canEditStructure={canEditStructure}
          showMatrix={showMatrix}
          isReviewPending={pendingReviewSubtaskIds.has(s.id)}
        />
      ))}
    </div>
  );
}

function InlineAddSubtask({
  task,
  blockId,
}: {
  task: TaskDoc;
  blockId: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await addSubtask(task, { title: trimmed, blockId });
      setDraft("");
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleAdd} style={{ display: "flex", gap: "var(--space-2)" }}>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={blockId ? "Add subtask to this block…" : "Add subtask…"}
        maxLength={TASK_FIELD_LIMITS.subtaskTitle}
        style={{
          flex: 1,
          padding: "0.5rem 0.75rem",
          background: "var(--color-bg-elevated)",
          border: "1px dashed var(--color-border)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-text)",
          fontSize: "var(--text-sm)",
        }}
      />
      <button
        type="submit"
        disabled={busy || !draft.trim()}
        style={{
          padding: "0.5rem 0.85rem",
          background: "var(--color-accent-soft)",
          color: "var(--color-accent)",
          border: "none",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--text-sm)",
          cursor: "pointer",
        }}
      >
        Add
      </button>
    </form>
  );
}

function InlineAddBlock({ task, hasBlocks }: { task: TaskDoc; hasBlocks: boolean }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          alignSelf: "flex-start",
          padding: "0.4rem 0.75rem",
          background: "transparent",
          border: "1px dashed var(--color-border)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-text-muted)",
          fontSize: "var(--text-xs)",
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        {hasBlocks ? "+ Add another block" : "+ Add a block"}
      </button>
    );
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await createBlock(task, trimmed);
      setDraft("");
      setOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleAdd}
      style={{
        display: "flex",
        gap: "var(--space-2)",
        alignItems: "center",
      }}
    >
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft("");
            setOpen(false);
          }
        }}
        placeholder="Block name (e.g. Drafting, Review, Publish)"
        maxLength={TASK_FIELD_LIMITS.blockName}
        style={{
          flex: 1,
          padding: "0.4rem 0.65rem",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-text)",
          fontSize: "var(--text-sm)",
        }}
      />
      <button
        type="submit"
        disabled={busy || !draft.trim()}
        style={{
          padding: "0.4rem 0.75rem",
          background: "var(--color-accent-soft)",
          color: "var(--color-accent)",
          border: "none",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--text-sm)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Add block
      </button>
      <button
        type="button"
        onClick={() => {
          setDraft("");
          setOpen(false);
        }}
        style={{
          padding: "0.4rem 0.5rem",
          background: "transparent",
          border: "none",
          color: "var(--color-text-muted)",
          fontSize: "var(--text-sm)",
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </form>
  );
}

function SortableSubtaskRow({
  id,
  children,
}: {
  id: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const handle = (
    <button
      type="button"
      aria-label="Drag to reorder"
      title="Drag to reorder"
      {...attributes}
      {...listeners}
      style={{
        background: "transparent",
        border: "none",
        color: "var(--color-text-subtle)",
        cursor: "grab",
        padding: "0.25rem 0.35rem",
        fontSize: "var(--text-md)",
        lineHeight: 1,
        touchAction: "none",
      }}
    >
      ≡
    </button>
  );

  return (
    <div ref={setNodeRef} style={style}>
      {children(handle)}
    </div>
  );
}

export const BLOCK_PHASE_PALETTE: Record<
  BlockPhase,
  { bg: string; border: string; label: string; labelColor: string }
> = {
  setup: {
    // Violet — picked to sit clearly before red in the phase progression so
    // a glance down the block stack reads as a gradient (violet → red →
    // orange → yellow → green) without two adjacent phases fighting for
    // attention.
    bg: "rgba(124, 58, 237, 0.08)",
    border: "#7c3aed",
    label: "Setup",
    labelColor: "#7c3aed",
  },
  allocating: {
    bg: "var(--color-danger-soft, rgba(220, 38, 38, 0.06))",
    border: "var(--color-danger, #dc2626)",
    label: "Allocating",
    labelColor: "var(--color-danger, #dc2626)",
  },
  "in-progress": {
    bg: "var(--color-warning-soft, var(--color-surface-hover))",
    border: "var(--color-warning, var(--color-accent))",
    label: "In progress",
    labelColor: "var(--color-warning, var(--color-text))",
  },
  reviewing: {
    bg: "var(--color-caution-soft, rgba(234, 179, 8, 0.10))",
    border: "var(--color-caution, #eab308)",
    label: "Under review",
    labelColor: "var(--color-caution, #a16207)",
  },
  complete: {
    bg: "var(--color-success-soft, rgba(22, 163, 74, 0.08))",
    border: "var(--color-success, #16a34a)",
    label: "Complete",
    labelColor: "var(--color-success, #16a34a)",
  },
};

// TaskBlock import is used implicitly via groupSubtasksByBlock's return type.
export type { TaskBlock };
