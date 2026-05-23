"use client";

import { useCallback, useMemo, useState } from "react";
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
import { Select } from "@/components/ui/Input";
import { canMarkTaskDone } from "@/lib/firestore/tasks";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskDoc,
  type TaskStatus,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import type { Role } from "@/lib/firebase/session";
import { setTaskStatus } from "../taskMutations";
import TaskCard from "./TaskCard";
import styles from "./TaskBoard.module.css";

type Props = {
  tasks: TaskDoc[];
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpenTask: (taskId: string) => void;
  viewerUid: string;
  viewerRole: Role;
};

type TaskPerms = { canChangeStatus: boolean; canMarkDone: boolean };

/**
 * Per-card permission gates for the move-dropdown. Mirrors
 * `canEditProgressFields` and the `canMarkDone` derivation in
 * TaskDetailModal so the dropdown's enabled states agree with the modal's
 * Status select.
 */
function computePerms(
  task: TaskDoc,
  viewerUid: string,
  viewerRole: Role,
): TaskPerms {
  const isAdmin = viewerRole === "admin";
  const isCommittee = viewerRole === "committee" || viewerRole === "admin";
  const isCompleter = task.completerUids.includes(viewerUid);
  const isTaskReviewer = task.reviewerUids.includes(viewerUid);
  const isAnyReviewer =
    isTaskReviewer ||
    task.subtasks.some((s) => s.reviewerUids.includes(viewerUid));
  const isCreator = task.creatorUid === viewerUid;
  const canEditAll =
    isAdmin ||
    (isCommittee && task.visibility === "committee") ||
    (task.source === "personal" && isCreator);
  const canChangeStatus = canEditAll || isCompleter || isAnyReviewer;
  const canMarkDoneViewer =
    task.reviewerUids.length > 0
      ? isAdmin || isTaskReviewer || isCreator
      : isAdmin || isCreator;
  const canMarkDone = canMarkDoneViewer && canMarkTaskDone(task).ok;
  return { canChangeStatus, canMarkDone };
}

function SortableTaskCard({
  task,
  projects,
  users,
  onOpen,
  perms,
  pendingStatus,
  onChangeStatus,
}: {
  task: TaskDoc;
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpen: (id: string) => void;
  perms?: TaskPerms;
  pendingStatus?: TaskStatus | null;
  onChangeStatus: (task: TaskDoc, status: TaskStatus) => void;
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
        pendingStatus={pendingStatus}
        onChangeStatus={(s) => onChangeStatus(task, s)}
        canChangeStatus={perms?.canChangeStatus}
        canMarkDone={perms?.canMarkDone}
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
  permsByTask,
  activePending,
  onStatusChange,
}: {
  status: TaskStatus;
  tasks: TaskDoc[];
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpenTask: (id: string) => void;
  permsByTask: Map<string, TaskPerms>;
  activePending: Record<string, TaskStatus>;
  onStatusChange: (task: TaskDoc, status: TaskStatus) => void;
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
              perms={permsByTask.get(task.id)}
              pendingStatus={activePending[task.id]}
              onChangeStatus={onStatusChange}
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

type SharedProps = {
  tasks: TaskDoc[];
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpenTask: (taskId: string) => void;
  activePending: Record<string, TaskStatus>;
  permsByTask: Map<string, TaskPerms>;
  onStatusChange: (task: TaskDoc, status: TaskStatus) => void;
};

function TaskBoardKanban({
  tasks,
  projects,
  users,
  onOpenTask,
  activePending,
  permsByTask,
  onStatusChange,
}: SharedProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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

  function handleDragEnd(e: DragEndEvent) {
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

    onStatusChange(task, targetStatus);
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
            permsByTask={permsByTask}
            activePending={activePending}
            onStatusChange={onStatusChange}
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

/**
 * Phone-shaped board: a status-filter dropdown at the top + a single-column
 * list of cards for the selected status. The per-card move-dropdown (rendered
 * by TaskCard when `onChangeStatus` is provided) is how the user reallocates
 * cards between statuses on phone — drag is desktop-only.
 *
 * The status filter mirrors the modal's status select; the per-card dropdown
 * mirrors its option-disabled rules via the `permsByTask` map.
 */
function TaskBoardPhone({
  tasks,
  projects,
  users,
  onOpenTask,
  activePending,
  permsByTask,
  onStatusChange,
}: SharedProps) {
  const [activeStatus, setActiveStatus] = useState<TaskStatus>(TASK_STATUSES[0]);

  // Counts honour optimistic overrides so the filter label updates the
  // instant the user changes a card's status.
  const counts = useMemo(() => {
    const map = new Map<TaskStatus, number>();
    TASK_STATUSES.forEach((s) => map.set(s, 0));
    for (const t of tasks) {
      const status = activePending[t.id] ?? t.status;
      map.set(status, (map.get(status) ?? 0) + 1);
    }
    return map;
  }, [tasks, activePending]);

  const filtered = useMemo(
    () =>
      tasks.filter((t) => (activePending[t.id] ?? t.status) === activeStatus),
    [tasks, activePending, activeStatus],
  );

  return (
    <div>
      <div className={styles.statusFilter}>
        <Select
          value={activeStatus}
          onChange={(e) => setActiveStatus(e.target.value as TaskStatus)}
          aria-label="View tasks by status"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]} ({counts.get(s) ?? 0})
            </option>
          ))}
        </Select>
      </div>
      <div className={styles.phoneList}>
        {filtered.length === 0 ? (
          <p className={styles.phoneEmpty}>
            No tasks in {TASK_STATUS_LABELS[activeStatus].toLowerCase()}.
          </p>
        ) : (
          filtered.map((task) => {
            const perms = permsByTask.get(task.id);
            return (
              <TaskCard
                key={task.id}
                task={task}
                projects={projects}
                users={users}
                onOpen={onOpenTask}
                pendingStatus={activePending[task.id]}
                onChangeStatus={(s) => onStatusChange(task, s)}
                canChangeStatus={perms?.canChangeStatus}
                canMarkDone={perms?.canMarkDone}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Top-level board. Owns the optimistic `pendingStatus` map so both the
 * desktop drag path AND the per-card move-dropdown share one rollback path,
 * and computes per-task permission gates once for both viewports.
 *
 * Both trees are always mounted so CSS alone decides which is visible — see
 * PR #149: kanban's `display: none` on phone keeps pointer events out of
 * dnd-kit, and the always-mounted layout removes the empty-`.kanbanOnly`
 * transient state that a JS matchMedia gate would otherwise produce when
 * resizing across `--bp-lg`.
 */
export default function TaskBoard({
  tasks,
  projects,
  users,
  onOpenTask,
  viewerUid,
  viewerRole,
}: Props) {
  // Optimistic status overrides: set on drag drop OR on move-dropdown change,
  // cleared once Firestore catches up. Without this the card snaps back to
  // its origin column / filter view for the duration of the round-trip
  // (~100–400ms) before the onSnapshot re-derives.
  const [pendingStatus, setPendingStatus] = useState<Record<string, TaskStatus>>({});

  // Prune any pending entries the snapshot has already caught up to. Derived
  // per-render rather than via effect to avoid the set-state-in-effect trap.
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

  const permsByTask = useMemo(() => {
    const map = new Map<string, TaskPerms>();
    for (const t of tasks) {
      map.set(t.id, computePerms(t, viewerUid, viewerRole));
    }
    return map;
  }, [tasks, viewerUid, viewerRole]);

  const handleStatusChange = useCallback(
    async (task: TaskDoc, newStatus: TaskStatus) => {
      setPendingStatus((p) => ({ ...p, [task.id]: newStatus }));
      try {
        await setTaskStatus(task, newStatus);
      } catch (err) {
        console.error("Failed to update status", err);
        setPendingStatus((p) => {
          const next = { ...p };
          delete next[task.id];
          return next;
        });
      }
    },
    [],
  );

  const shared: SharedProps = {
    tasks,
    projects,
    users,
    onOpenTask,
    activePending,
    permsByTask,
    onStatusChange: handleStatusChange,
  };

  return (
    <>
      <div className={styles.kanbanOnly}>
        <TaskBoardKanban {...shared} />
      </div>
      <div className={styles.phoneOnly}>
        <TaskBoardPhone {...shared} />
      </div>
    </>
  );
}
