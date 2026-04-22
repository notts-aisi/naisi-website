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
  groupSubtasksByBlock,
  type TaskBlock,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import type { Role } from "@/lib/firebase/session";
import {
  addSubtask,
  applyBlockGate,
  clearBlockGate,
  createBlock,
  getNextBlock,
  isBlockGateApplied,
  reorderSubtasks,
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
  showMatrix,
  pendingReviewSubtaskIds,
}: Props) {
  const isAdmin = viewerRole === "admin";
  const isCreator = task.creatorUid === viewerUid;

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
        if (g.subtasks.some((s) => nextGroupSet.has(s.id))) {
          fullOrder.push(...nextGroup);
        } else {
          for (const s of g.subtasks) fullOrder.push(s.id);
        }
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
        const isSealed = group.block?.sealState === "sealed";
        const containerStyle: React.CSSProperties = group.block
          ? {
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              background: isSealed
                ? "var(--color-success-soft, rgba(22, 163, 74, 0.04))"
                : "var(--color-bg-elevated)",
              border: `1px solid ${
                isSealed
                  ? "var(--color-success, #16a34a)"
                  : "var(--color-border)"
              }`,
              borderLeftWidth: "3px",
              borderRadius: "var(--radius-md)",
            }
          : {
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            };
        return (
          <div
            key={group.block ? group.block.id : "__ungrouped__"}
            style={containerStyle}
          >
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
            {group.subtasks.length === 0 && group.block && canEdit && (
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
            {canEdit && group.subtasks.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={makeDragEndHandler(group.subtasks.map((s) => s.id))}
              >
                <SortableContext
                  items={group.subtasks.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {group.subtasks.map((s) => (
                    <SortableSubtaskRow key={s.id} id={s.id}>
                      {(handle) => (
                        <SubtaskRow
                          task={task}
                          subtask={s}
                          users={users}
                          viewerUid={viewerUid}
                          isAdmin={isAdmin}
                          canEdit={canEdit}
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
              group.subtasks.map((s) => (
                <SubtaskRow
                  key={s.id}
                  task={task}
                  subtask={s}
                  users={users}
                  viewerUid={viewerUid}
                  isAdmin={isAdmin}
                  canEdit={canEdit}
                  showMatrix={showMatrix}
                  isReviewPending={pendingReviewSubtaskIds.has(s.id)}
                />
              ))
            )}
            {canEdit && task.subtasks.length < TASK_FIELD_LIMITS.maxSubtasks && (
              <InlineAddSubtask task={task} blockId={group.block?.id ?? null} />
            )}
            {group.block && canEditStructure && (
              <BlockGateControls task={task} blockId={group.block.id} />
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
 * Post-seal gate control. Only renders when the block is sealed and has a
 * downstream block to gate. If review subtasks haven't spawned (no effective
 * reviewers), button is disabled with an explanatory tooltip. Otherwise it
 * toggles applied/cleared — pressing Apply sets every non-reviewer subtask
 * in the next block to `blockedBy` including all of this block's review
 * subtask ids.
 */
function BlockGateControls({ task, blockId }: { task: TaskDoc; blockId: string }) {
  const block = task.blocks.find((b) => b.id === blockId);
  if (!block || block.sealState !== "sealed") return null;
  const nextBlock = getNextBlock(task, blockId);
  if (!nextBlock) return null;
  const hasReviewSubtasks = task.subtasks.some(
    (s) => s.blockId === blockId && s.roleHint === "reviewer",
  );
  const applied = isBlockGateApplied(task, blockId);

  async function handleToggle() {
    try {
      if (applied) {
        await clearBlockGate(task, blockId);
      } else {
        await applyBlockGate(task, blockId);
      }
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Update failed");
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
          fontSize: "var(--text-xs)",
          color: "var(--color-text-muted)",
          flex: 1,
        }}
      >
        {hasReviewSubtasks
          ? `Gate "${nextBlock.name}" on this block's reviews?`
          : `"${nextBlock.name}" gates on reviewer signoffs — waiting for them to spawn.`}
      </span>
      <button
        type="button"
        disabled={!hasReviewSubtasks}
        onClick={handleToggle}
        style={{
          padding: "0.3rem 0.75rem",
          background: applied
            ? "var(--color-warning-soft, var(--color-surface-hover))"
            : "var(--color-accent-soft)",
          color: applied
            ? "var(--color-warning, var(--color-text))"
            : "var(--color-accent)",
          border: "none",
          borderRadius: "var(--radius-sm, 4px)",
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          cursor: hasReviewSubtasks ? "pointer" : "not-allowed",
          opacity: hasReviewSubtasks ? 1 : 0.5,
        }}
        title={
          hasReviewSubtasks
            ? applied
              ? `Stop gating "${nextBlock.name}" on this block's reviews`
              : `Require this block's reviewer signoffs before "${nextBlock.name}" unlocks`
            : "This block has no review subtasks — add task reviewers or seal it first."
        }
      >
        {applied ? "Gate applied — clear" : "Gate next block"}
      </button>
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
        {hasBlocks ? "+ Add another block" : "+ Group subtasks into a block"}
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

// TaskBlock import is used implicitly via groupSubtasksByBlock's return type.
export type { TaskBlock };
