"use client";

import { useMemo } from "react";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { TASK_KIND_LABELS, getSubtaskBreakdown, type TaskDoc } from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import DueDateBadge from "./DueDateBadge";
import SubtaskBreakdown from "./SubtaskBreakdown";

type Props = {
  task: TaskDoc;
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpen: (taskId: string) => void;
  dense?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
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
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div
          style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)", alignItems: "flex-start" }}
        >
          <div
            style={{
              flex: 1,
              fontSize: "var(--text-sm)",
              fontWeight: 500,
              color: "var(--color-text)",
            }}
          >
            {task.title}
          </div>
          <div style={{ display: "flex", gap: "var(--space-1)", alignItems: "center" }}>
            {task.archived && <Badge tone="neutral">Archived</Badge>}
            {task.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
            {dragHandleProps && (
              <button
                type="button"
                aria-label="Drag to reorder or move between columns"
                title="Drag to reorder or move between columns"
                {...dragHandleProps}
                onClick={(e) => {
                  // Purely a drag handle — don't let a click on it open the modal.
                  e.stopPropagation();
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "1.4rem",
                  height: "1.4rem",
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  color: "var(--color-text-subtle)",
                  cursor: "grab",
                  fontSize: "var(--text-md)",
                  lineHeight: 1,
                  touchAction: "none",
                  userSelect: "none",
                }}
              >
                ≡
              </button>
            )}
          </div>
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
          <SubtaskBreakdown breakdown={getSubtaskBreakdown(task)} variant="compact" />
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
          }}
        >
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
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                color: "var(--color-text-subtle)",
              }}
            >
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
  const nameColor =
    tone === "warning"
      ? "var(--color-warning, var(--color-text))"
      : "var(--color-accent)";
  if (people.length === 0) {
    if (!emptyLabel) return null;
    return (
      <div>
        <span style={{ color: "var(--color-text-subtle)" }}>{emptyLabel}</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
      <span style={{ color: "var(--color-text-subtle)" }}>{label}:</span>
      {people.map((u, i) => (
        <span key={u.uid} style={{ color: nameColor, fontWeight: 500 }}>
          {nameOf(u)}
          {i < people.length - 1 ? "," : ""}
        </span>
      ))}
    </div>
  );
}
