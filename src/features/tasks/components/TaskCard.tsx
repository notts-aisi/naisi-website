"use client";

import { useMemo } from "react";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import {
  TASK_KIND_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  getSubtaskBreakdown,
  type TaskDoc,
  type TaskStatus,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import DueDateBadge from "./DueDateBadge";
import SubtaskBreakdown from "./SubtaskBreakdown";
import styles from "./TaskCard.module.css";

type Props = {
  task: TaskDoc;
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpen: (taskId: string) => void;
  dense?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
  /** Optimistic status override applied while a Firestore write is in flight.
   *  When set, the move-dropdown shows this value instead of `task.status`. */
  pendingStatus?: TaskStatus | null;
  /** Present means render the top-right move-dropdown. Receives the chosen
   *  target status; the parent owns the mutation + optimistic update. */
  onChangeStatus?: (status: TaskStatus) => void;
  canChangeStatus?: boolean;
  canMarkDone?: boolean;
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "var(--color-text-subtle)",
  normal: "var(--color-text-muted)",
  high: "var(--color-warning)",
  urgent: "var(--color-danger)",
};

const SOURCE_LABELS: Record<string, string> = {
  committee: "Committee",
  "fellowship-reminder": "Fellowship",
  personal: "Personal",
};

export default function TaskCard({
  task,
  projects,
  users,
  onOpen,
  dense,
  dragHandleProps,
  isDragging,
  pendingStatus,
  onChangeStatus,
  canChangeStatus,
  canMarkDone,
}: Props) {
  const effectiveStatus = pendingStatus ?? task.status;
  const project = useMemo(
    () => (task.projectId ? projects.find((p) => p.id === task.projectId) : null),
    [task.projectId, projects],
  );

  const completers = useMemo(
    () =>
      task.completerUids
        .map((uid) => users.find((u) => u.uid === uid))
        .filter((u): u is UserDoc => Boolean(u)),
    [task.completerUids, users],
  );
  const reviewers = useMemo(
    () =>
      task.reviewerUids
        .map((uid) => users.find((u) => u.uid === uid))
        .filter((u): u is UserDoc => Boolean(u)),
    [task.reviewerUids, users],
  );

  function nameOf(u: UserDoc): string {
    return u.displayName ?? u.email ?? u.uid;
  }

  return (
    <Card
      padding={dense ? "sm" : "md"}
      interactive
      onClick={() => onOpen(task.id)}
      style={{
        cursor: "pointer",
        opacity: isDragging ? 0.4 : task.archived ? 0.65 : 1,
        borderLeft: `3px solid ${PRIORITY_COLORS[task.priority] ?? "transparent"}`,
        borderStyle: task.archived ? "dashed" : undefined,
      }}
    >
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <div className={styles.title}>{task.title}</div>
          <div className={styles.badgeCluster}>
            {task.archived && <Badge tone="neutral">Archived</Badge>}
            {task.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
            {onChangeStatus && (
              <Dropdown<TaskStatus>
                value={effectiveStatus}
                onChange={onChangeStatus}
                disabled={!canChangeStatus}
                size="sm"
                /* Sheet at --bp-md so the 48–60rem band uses the bottom
                   sheet instead of the popover (which can render outside
                   17rem kanban columns). */
                sheetBreakpoint="md"
                ariaLabel="Change status"
                title={
                  canChangeStatus
                    ? "Change status"
                    : "You don't have permission to change this task's status"
                }
                className={styles.statusTrigger}
                options={TASK_STATUSES.map<DropdownOption<TaskStatus>>((s) => ({
                  value: s,
                  label: TASK_STATUS_LABELS[s],
                  // Mirror the modal: block "done" when the viewer can't
                  // mark done AND the task isn't already done.
                  disabled:
                    s === "done" && effectiveStatus !== "done" && !canMarkDone,
                }))}
              />
            )}
            {dragHandleProps && (
              <button
                type="button"
                aria-label="Drag to reorder or move between columns"
                title="Drag to reorder or move between columns"
                {...dragHandleProps}
                onClick={(e) => {
                  // Drag handle — never open the modal.
                  e.stopPropagation();
                }}
                className={styles.dragHandle}
              >
                ≡
              </button>
            )}
          </div>
        </div>

        {!dense && task.description && (
          <p className={styles.description}>{task.description}</p>
        )}

        <div className={styles.metaBadges}>
          {project && <Badge tone="accent">{project.name}</Badge>}
          {(task.kind === "social" || task.kind === "event") && (
            <Badge tone="success">{TASK_KIND_LABELS[task.kind]}</Badge>
          )}
          {task.kind === "instagram-post" && <Badge tone="warning">Insta post</Badge>}
          {task.kind === "instagram-story" && <Badge tone="warning">Insta story</Badge>}
          {task.source !== "committee" && (
            <Badge tone="neutral">{SOURCE_LABELS[task.source]}</Badge>
          )}
          <DueDateBadge dueDate={task.dueDate} done={task.status === "done"} />
        </div>

        {task.subtaskStats.total > 0 && (
          <SubtaskBreakdown breakdown={getSubtaskBreakdown(task)} variant="compact" />
        )}

        <div className={styles.peopleColumn}>
          <PeopleLine
            label="Assigned to"
            people={completers}
            tone="accent"
            emptyLabel="Unassigned"
            nameOf={nameOf}
          />
          {reviewers.length > 0 && (
            <PeopleLine
              label={reviewers.length === 1 ? "Reviewer" : "Reviewers"}
              people={reviewers}
              tone="warning"
              emptyLabel={null}
              nameOf={nameOf}
            />
          )}
          {(task.commentCount > 0 || task.attachmentCount > 0) && (
            <div className={styles.metaCounts}>
              {task.commentCount > 0 && <span>💬 {task.commentCount}</span>}
              {task.attachmentCount > 0 && <span>📎 {task.attachmentCount}</span>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function PeopleLine({
  label,
  people,
  tone,
  emptyLabel,
  nameOf,
}: {
  label: string;
  people: UserDoc[];
  tone: "accent" | "warning";
  emptyLabel: string | null;
  nameOf: (u: UserDoc) => string;
}) {
  if (people.length === 0) {
    if (!emptyLabel) return null;
    return (
      <div>
        <span className={styles.peopleLabel}>{emptyLabel}</span>
      </div>
    );
  }
  const nameClass =
    tone === "warning"
      ? `${styles.peopleName} ${styles.peopleNameReviewer}`
      : styles.peopleName;
  return (
    <div className={styles.peopleLine}>
      <span className={styles.peopleLabel}>{label}:</span>
      {people.map((u, i) => (
        <span key={u.uid} className={nameClass}>
          {nameOf(u)}
          {i < people.length - 1 ? "," : ""}
        </span>
      ))}
    </div>
  );
}
