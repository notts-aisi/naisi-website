"use client";

import { useMemo } from "react";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import ProgressBar from "@/components/ui/ProgressBar";
import { TASK_KIND_LABELS, type TaskDoc } from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import DueDateBadge from "./DueDateBadge";

type Props = {
  task: TaskDoc;
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpen: (taskId: string) => void;
  dense?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
  isDragging?: boolean;
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
}: Props) {
  const project = useMemo(
    () => (task.projectId ? projects.find((p) => p.id === task.projectId) : null),
    [task.projectId, projects],
  );

  const assignees = useMemo(
    () =>
      task.assigneeUids
        .map((uid) => users.find((u) => u.uid === uid))
        .filter((u): u is UserDoc => Boolean(u)),
    [task.assigneeUids, users],
  );

  const subtasksComplete = task.subtaskStats.total > 0 && task.subtaskStats.done === task.subtaskStats.total;

  return (
    <Card
      padding={dense ? "sm" : "md"}
      interactive
      onClick={() => onOpen(task.id)}
      style={{
        cursor: "pointer",
        opacity: isDragging ? 0.4 : 1,
        borderLeft: `3px solid ${PRIORITY_COLORS[task.priority] ?? "transparent"}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div
          style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)", alignItems: "flex-start" }}
        >
          <div
            {...(dragHandleProps ?? {})}
            onClick={(e) => {
              // Don't open the modal when starting a drag.
              if (dragHandleProps) e.stopPropagation();
            }}
            style={{
              flex: 1,
              fontSize: "var(--text-sm)",
              fontWeight: 500,
              color: "var(--color-text)",
              cursor: dragHandleProps ? "grab" : "inherit",
              userSelect: "none",
            }}
          >
            {task.title}
          </div>
          {task.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
        </div>

        {!dense && task.description && (
          <p
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--color-text-muted)",
              margin: 0,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {task.description}
          </p>
        )}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            alignItems: "center",
          }}
        >
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
          <ProgressBar
            value={task.subtaskStats.done}
            max={task.subtaskStats.total}
            ariaLabel={`Subtasks: ${task.subtaskStats.done} of ${task.subtaskStats.total} done`}
            tone={subtasksComplete ? "success" : "accent"}
            size="sm"
            showLabel
          />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "var(--text-xs)",
            color: "var(--color-text-subtle)",
          }}
        >
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            {assignees.slice(0, 3).map((u) => {
              const initial = (u.displayName ?? u.email ?? "?").charAt(0).toUpperCase();
              return (
                <span
                  key={u.uid}
                  title={u.displayName ?? u.email ?? u.uid}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "1.5rem",
                    height: "1.5rem",
                    borderRadius: "50%",
                    background: "var(--color-surface-hover)",
                    color: "var(--color-text)",
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                  }}
                >
                  {initial}
                </span>
              );
            })}
            {assignees.length > 3 && <span>+{assignees.length - 3}</span>}
            {assignees.length === 0 && <span>Unassigned</span>}
          </div>
          {(task.commentCount > 0 || task.attachmentCount > 0) && (
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              {task.commentCount > 0 && <span>💬 {task.commentCount}</span>}
              {task.attachmentCount > 0 && <span>📎 {task.attachmentCount}</span>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
