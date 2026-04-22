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
import { TASK_FIELD_LIMITS, type TaskDoc } from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import { addSubtask, reorderSubtasks } from "../taskMutations";
import SubtaskRow from "./SubtaskRow";

type Props = {
  task: TaskDoc;
  users: UserDoc[];
  viewerUid: string;
  canEdit: boolean;
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
  canEdit,
  showMatrix,
  pendingReviewSubtaskIds,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // `activationConstraint` prevents accidental drags when the user is just
  // clicking checkboxes or text inputs inside a row.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await addSubtask(task, { title: trimmed });
      setDraft("");
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = task.subtasks.map((s) => s.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const next = [...ids];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, String(active.id));
    try {
      await reorderSubtasks(task, next);
    } catch (err) {
      console.error(err);
    }
  }

  const rows = task.subtasks;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {rows.length === 0 && !canEdit && (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
          No subtasks.
        </p>
      )}

      {canEdit ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rows.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {rows.map((s) => (
              <SortableSubtaskRow key={s.id} id={s.id}>
                {(handle) => (
                  <SubtaskRow
                    task={task}
                    subtask={s}
                    users={users}
                    viewerUid={viewerUid}
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
        rows.map((s) => (
          <SubtaskRow
            key={s.id}
            task={task}
            subtask={s}
            users={users}
            viewerUid={viewerUid}
            canEdit={false}
            showMatrix={showMatrix}
            isReviewPending={pendingReviewSubtaskIds.has(s.id)}
          />
        ))
      )}

      {canEdit && rows.length < TASK_FIELD_LIMITS.maxSubtasks && (
        <form onSubmit={handleAdd} style={{ display: "flex", gap: "var(--space-2)" }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add subtask…"
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
      )}
    </div>
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
