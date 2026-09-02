"use client";

import { useMemo } from "react";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import {
  TASK_KIND_LABELS,
  TASK_SOURCE_LABELS,
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

/**
 * The one-way sentence, stated once and reused on both course affordances.
 *
 * A mirrored task is a PROJECTION of a course week, not a second handle on it:
 * the tick here and the check-off in the course are separate rows in separate
 * collections, and nothing propagates either way. A member who assumes
 * otherwise will close the task and believe their week is marked complete,
 * which is the single misreading this feature can cause — so the card has to
 * say so.
 *
 * It says so in a `title` and in visually-hidden link text rather than in a
 * visible paragraph: this is one card type on a board that may show dozens,
 * and a standing explanation on every one of them would cost far more
 * attention than the misreading it prevents. Screen-reader users get the whole
 * sentence in the link's accessible name, where `title` alone is unreliable.
 */
const ONE_WAY_NOTE =
  "One-way copy from your course — ticking this off here doesn't check anything off in the course.";

/**
 * The mirrored-task marker, or null for every other card.
 *
 * Both halves are required. `source` alone is not enough: `fellowship-reminder`
 * predates courses and is still reachable from other paths, and one of those
 * without a `sourceRef` has no week to link to. `weekNumber >= 1` guards the
 * href — a 0 or negative from a malformed doc would build a link to a route
 * that cannot exist, and no link at all beats a broken one.
 */
function courseRefOf(task: TaskDoc): { cohortId: string; weekNumber: number } | null {
  if (task.source !== "fellowship-reminder") return null;
  const ref = task.sourceRef;
  if (!ref || !ref.cohortId || ref.weekNumber < 1) return null;
  return ref;
}

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

  const courseRef = useMemo(() => courseRefOf(task), [task]);

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
          {/* A course mirror says "Course" rather than "Fellowship" — the
              badge row is where markers live, and this is the marker. The
              week NUMBER is carried by the link below instead: it is longer,
              it would wrap a 17rem kanban column, and it is only actionable
              down there. Every other source is untouched. */}
          {courseRef ? (
            <Badge tone="neutral" title={ONE_WAY_NOTE}>
              Course
            </Badge>
          ) : (
            task.source !== "committee" && (
              <Badge tone="neutral">{TASK_SOURCE_LABELS[task.source]}</Badge>
            )
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

          {/* The way back to the thing this card is a copy of. `stopPropagation`
              because the whole Card is a click target that opens the task
              modal — without it the tap would both navigate and open a modal
              behind it. */}
          {courseRef && (
            <Link
              href={`/learn/${encodeURIComponent(courseRef.cohortId)}/weeks/${courseRef.weekNumber}`}
              className={styles.courseLink}
              title={ONE_WAY_NOTE}
              onClick={(e) => e.stopPropagation()}
            >
              {/* The week number lives here rather than in the title, which a
                  member may rename — this line stays true either way. */}
              Week {courseRef.weekNumber} in the course
              <span className={styles.courseNote}> — {ONE_WAY_NOTE}</span>
              <span className={styles.courseArrow} aria-hidden="true">
                ↗
              </span>
            </Link>
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
