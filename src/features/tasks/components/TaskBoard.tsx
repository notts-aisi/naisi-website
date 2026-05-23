"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskDoc,
  type TaskStatus,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import { maxWidth } from "@/theme/breakpoints";
import { setTaskStatus } from "../taskMutations";
import TaskCard from "./TaskCard";
import styles from "./TaskBoard.module.css";

type Props = {
  tasks: TaskDoc[];
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpenTask: (taskId: string) => void;
};

/**
 * `useSyncExternalStore` over a matchMedia query. Used to GATE mounting of
 * the kanban tree — the visibility flip itself is CSS-driven so the initial
 * SSR paint on phone never shows the wide kanban (5x17rem columns would push
 * past the viewport before hydration completes, causing body-level
 * horizontal scroll for as long as JS takes to load + parse + hydrate).
 *
 * Plan revision after PR #145 landed and the flash was unacceptable on real
 * phones: render both trees, CSS hides the wrong one always (including
 * during SSR), and this hook gates whether the heavy `DndContext` +
 * `useSortable` hook surface actually mounts. The original plan's cost
 * concern was the dnd-kit hooks, not duplicate DOM — duplicate DOM is cheap;
 * the hooks aren't.
 *
 * Same shape as `Drawer.tsx`'s `isClient` check.
 */
const NARROW_QUERY = maxWidth("lg");

function subscribeNarrow(cb: () => void): () => void {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function getNarrowSnapshot(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function getNarrowServerSnapshot(): boolean {
  return false;
}

function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getNarrowSnapshot, getNarrowServerSnapshot);
}

function SortableTaskCard({
  task,
  projects,
  users,
  onOpen,
}: {
  task: TaskDoc;
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "task", status: task.status },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <TaskCard
        task={task}
        projects={projects}
        users={users}
        onOpen={onOpen}
        dense
        dragHandleProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLDivElement>}
        isDragging={isDragging}
      />
    </div>
  );
}

function BoardColumn({
  status,
  tasks,
  projects,
  users,
  onOpenTask,
}: {
  status: TaskStatus;
  tasks: TaskDoc[];
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpenTask: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { type: "column", status },
  });

  return (
    <div className={styles.column}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.4rem 0.75rem",
          fontSize: "var(--text-xs)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--color-text-muted)",
        }}
      >
        <span>{TASK_STATUS_LABELS[status]}</span>
        <span style={{ color: "var(--color-text-subtle)" }}>{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          padding: "var(--space-2)",
          background: isOver ? "var(--color-accent-soft)" : "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          minHeight: "8rem",
          transition: "background var(--transition-fast)",
        }}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              projects={projects}
              users={users}
              onOpen={onOpenTask}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <p
            style={{
              textAlign: "center",
              padding: "var(--space-4)",
              color: "var(--color-text-subtle)",
              fontSize: "var(--text-xs)",
            }}
          >
            Drop a card here
          </p>
        )}
      </div>
    </div>
  );
}

function TaskBoardKanban({ tasks, projects, users, onOpenTask }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Optimistic status overrides: set on drop, cleared once Firestore catches up.
  // Without this, the card snaps back to its origin column for the duration of
  // the Firestore round-trip (~100–400ms) before the onSnapshot re-derives.
  const [pendingStatus, setPendingStatus] = useState<Record<string, TaskStatus>>({});
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Prune any pending entries that the snapshot has already caught up to.
  // Derived per-render rather than via effect to avoid the set-state-in-effect
  // trap; memoized so downstream consumers get stable references.
  const activePending = useMemo(() => {
    const out: Record<string, TaskStatus> = {};
    let changed = false;
    for (const [id, status] of Object.entries(pendingStatus)) {
      const t = tasks.find((x) => x.id === id);
      if (t && t.status !== status) {
        out[id] = status;
      } else {
        changed = true;
      }
    }
    return changed ? out : pendingStatus;
  }, [tasks, pendingStatus]);

  const byStatus = useMemo(() => {
    const map = new Map<TaskStatus, TaskDoc[]>();
    TASK_STATUSES.forEach((s) => map.set(s, []));
    for (const t of tasks) {
      const status = activePending[t.id] ?? t.status;
      map.get(status)?.push(t);
    }
    return map;
  }, [tasks, activePending]);

  const draggingTask = draggingId ? tasks.find((t) => t.id === draggingId) : null;

  function handleDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
  }

  async function handleDragEnd(e: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = e;
    if (!over) return;
    const task = tasks.find((t) => t.id === active.id);
    if (!task) return;

    let targetStatus: TaskStatus | null = null;
    const overData = over.data.current;
    if (overData?.type === "column") {
      targetStatus = overData.status as TaskStatus;
    } else if (overData?.type === "task") {
      targetStatus = overData.status as TaskStatus;
    }
    const currentStatus = activePending[task.id] ?? task.status;
    if (!targetStatus || targetStatus === currentStatus) return;

    // Apply optimistic override BEFORE awaiting the Firestore write.
    setPendingStatus((p) => ({ ...p, [task.id]: targetStatus as TaskStatus }));

    try {
      await setTaskStatus(task, targetStatus);
    } catch (err) {
      console.error("Failed to update status", err);
      // Roll back on failure.
      setPendingStatus((p) => {
        const next = { ...p };
        delete next[task.id];
        return next;
      });
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className={styles.scroll}>
        {TASK_STATUSES.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={byStatus.get(status) ?? []}
            projects={projects}
            users={users}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
      <DragOverlay>
        {draggingTask ? (
          <TaskCard task={draggingTask} projects={projects} users={users} onOpen={() => {}} dense />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function TaskBoardPhone({ tasks, projects, users, onOpenTask }: Props) {
  const [activeStatus, setActiveStatus] = useState<TaskStatus>(TASK_STATUSES[0]);
  const activePillRef = useRef<HTMLButtonElement | null>(null);

  // Centre the initial active pill in the scrollable row on mount only.
  // Subsequent pill taps must NOT re-centre — that would jerk the row out
  // from under the user's finger.
  useEffect(() => {
    activePillRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, []);

  const counts = useMemo(() => {
    const map = new Map<TaskStatus, number>();
    TASK_STATUSES.forEach((s) => map.set(s, 0));
    for (const t of tasks) {
      map.set(t.status, (map.get(t.status) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  const filtered = useMemo(
    () => tasks.filter((t) => t.status === activeStatus),
    [tasks, activeStatus],
  );

  return (
    <div>
      <div className={styles.statusPills} role="tablist" aria-label="Filter by status">
        {TASK_STATUSES.map((status) => {
          const active = status === activeStatus;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={active}
              ref={active ? activePillRef : undefined}
              className={active ? `${styles.statusPill} ${styles.statusPillActive}` : styles.statusPill}
              onClick={() => setActiveStatus(status)}
            >
              <span>{TASK_STATUS_LABELS[status]}</span>
              <span className={styles.pillCount}>{counts.get(status) ?? 0}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.phoneList}>
        {filtered.length === 0 ? (
          <p className={styles.phoneEmpty}>
            No tasks in {TASK_STATUS_LABELS[activeStatus].toLowerCase()}.
          </p>
        ) : (
          filtered.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              projects={projects}
              users={users}
              onOpen={onOpenTask}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default function TaskBoard(props: Props) {
  const narrow = useIsNarrow();
  // Both trees are always rendered structurally so the initial SSR paint is
  // correct regardless of viewport (CSS decides which is visible). The
  // kanban tree only mounts its DndContext + useSortable hooks when the
  // client-side matchMedia hook confirms a desktop viewport, so phone never
  // pays the dnd-kit cost.
  return (
    <>
      <div className={styles.kanbanOnly}>
        {!narrow && <TaskBoardKanban {...props} />}
      </div>
      <div className={styles.phoneOnly}>
        <TaskBoardPhone {...props} />
      </div>
    </>
  );
}
