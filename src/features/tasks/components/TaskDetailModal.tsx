"use client";

import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import ProgressBar from "@/components/ui/ProgressBar";
import {
  TASK_FIELD_LIMITS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
  type TaskVisibility,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import type { Role } from "@/lib/firebase/session";
import { useTask } from "../hooks/useTask";
import {
  archiveTask,
  deleteTask,
  setTaskStatus,
  setTaskVisibility,
  updateTask,
} from "../taskMutations";
import AssigneePicker from "./AssigneePicker";
import AttachmentList from "./AttachmentList";
import AttachmentUpload from "./AttachmentUpload";
import CommentThread from "./CommentThread";
import DueDateBadge from "./DueDateBadge";
import SubtaskList from "./SubtaskList";
import { useTaskAttachments } from "../hooks/useTaskAttachments";

type Props = {
  taskId: string;
  viewerUid: string;
  viewerRole: Role;
  projects: ProjectDoc[];
  users: UserDoc[];
  onClose: () => void;
};

function toDateInputValue(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TaskDetailModal({
  taskId,
  viewerUid,
  viewerRole,
  projects,
  users,
  onClose,
}: Props) {
  const { task, loading } = useTask(taskId);
  const isAdmin = viewerRole === "admin";
  const isCommittee = viewerRole === "committee" || viewerRole === "admin";
  const isCompleter = task ? task.completerUids.includes(viewerUid) : false;
  const isReviewer = task ? task.reviewerUids.includes(viewerUid) : false;
  const isCreator = task ? task.creatorUid === viewerUid : false;
  const canEditAll =
    !!task &&
    (isAdmin ||
      (isCommittee && task.visibility === "committee") ||
      (task.source === "personal" && isCreator));
  // Completers and reviewers both can tick subtasks and change status.
  // Reviewers in this band is what lets them tick their review step even if
  // they're not on the completer list.
  const canEditProgressFields = canEditAll || isCompleter || isReviewer;

  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  // Sync drafts when the loaded task changes. Calling setState during render
  // based on a previous-value ref is React's supported pattern for
  // derived-from-props resets (avoids the react-hooks/set-state-in-effect trap
  // that flags synchronous in-effect setState).
  const [syncedId, setSyncedId] = useState<string | null>(null);
  if (task && task.id !== syncedId) {
    setSyncedId(task.id);
    setTitleDraft(task.title);
    setDescDraft(task.description);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const project = task?.projectId ? projects.find((p) => p.id === task.projectId) : null;
  const creator = task ? users.find((u) => u.uid === task.creatorUid) : null;

  if (loading || !task) {
    return (
      <Overlay onClose={onClose}>
        <div style={{ padding: "var(--space-6)", color: "var(--color-text-muted)" }}>
          {loading ? "Loading task…" : "Task not found or you don't have access."}
        </div>
      </Overlay>
    );
  }

  async function saveTitle() {
    if (!task) return;
    const t = titleDraft.trim();
    if (!t || t === task.title) {
      setEditingTitle(false);
      return;
    }
    try {
      await updateTask(task.id, { title: t });
    } catch (err) {
      console.error(err);
    }
    setEditingTitle(false);
  }

  async function saveDesc() {
    if (!task) return;
    if (descDraft === task.description) {
      setEditingDesc(false);
      return;
    }
    try {
      await updateTask(task.id, { description: descDraft });
    } catch (err) {
      console.error(err);
    }
    setEditingDesc(false);
  }

  async function onStatusChange(next: TaskStatus) {
    try {
      await setTaskStatus(task!, next);
    } catch (err) {
      console.error(err);
    }
  }

  async function onPriorityChange(next: TaskPriority) {
    try {
      await updateTask(task!.id, { priority: next });
    } catch (err) {
      console.error(err);
    }
  }

  async function onDueChange(value: string) {
    const date = value ? new Date(value) : null;
    try {
      await updateTask(task!.id, { dueDate: date });
    } catch (err) {
      console.error(err);
    }
  }

  async function onProjectChange(value: string) {
    try {
      await updateTask(task!.id, { projectId: value || null });
    } catch (err) {
      console.error(err);
    }
  }

  async function onCompletersChange(uids: string[]) {
    try {
      await updateTask(task!.id, { completerUids: uids });
    } catch (err) {
      console.error(err);
    }
  }

  async function onReviewersChange(uids: string[]) {
    try {
      await updateTask(task!.id, { reviewerUids: uids });
    } catch (err) {
      console.error(err);
    }
  }

  async function onVisibilityChange(v: TaskVisibility) {
    try {
      await setTaskVisibility(task!.id, v);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete() {
    if (!task) return;
    if (!window.confirm("Delete this task? This cannot be undone.")) return;
    try {
      await deleteTask(task.id);
      onClose();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleArchiveToggle() {
    if (!task) return;
    try {
      await archiveTask(task.id, !task.archived);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(16rem, 1fr)",
          // Fixed row so children with overflow can bound their content. Using
          // maxHeight without an explicit row height lets the grid grow with
          // content and breaks internal scroll (the main column never knows
          // it's constrained).
          gridTemplateRows: "85vh",
          gap: 0,
        }}
      >
        {/* Main column */}
        <div
          style={{
            padding: "var(--space-6)",
            overflowY: "auto",
            // min-height: 0 is the classic grid/flex scroll fix — without it a
            // scrollable child inherits its intrinsic height instead of the
            // grid row's bounded height.
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-5)",
          }}
        >
          {editingTitle && canEditAll ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setTitleDraft(task.title);
                  setEditingTitle(false);
                }
              }}
              maxLength={TASK_FIELD_LIMITS.title}
              style={{
                fontSize: "var(--text-xl)",
                fontWeight: 600,
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-2)",
                color: "var(--color-text)",
              }}
            />
          ) : (
            <h2
              onClick={() => canEditAll && setEditingTitle(true)}
              style={{
                fontSize: "var(--text-xl)",
                fontWeight: 600,
                margin: 0,
                cursor: canEditAll ? "text" : "default",
              }}
            >
              {task.title}
            </h2>
          )}

          <div
            style={{
              display: "grid",
              gap: "var(--space-3)",
              gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
              alignItems: "end",
            }}
          >
            <label style={fieldLabel}>
              <span>Status</span>
              <Select
                value={task.status}
                onChange={(e) => onStatusChange(e.target.value as TaskStatus)}
                disabled={!canEditProgressFields}
                aria-label="Status"
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </label>
            {canEditAll ? (
              <label style={fieldLabel}>
                <span>Priority</span>
                <Select
                  value={task.priority}
                  onChange={(e) => onPriorityChange(e.target.value as TaskPriority)}
                  aria-label="Priority"
                >
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {TASK_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <Badge tone="neutral">Priority: {TASK_PRIORITY_LABELS[task.priority]}</Badge>
            )}
            {canEditAll ? (
              <label style={fieldLabel}>
                <span>Due date</span>
                <Input
                  type="date"
                  value={toDateInputValue(task.dueDate)}
                  onChange={(e) => onDueChange(e.target.value)}
                  aria-label="Due date"
                />
              </label>
            ) : (
              <DueDateBadge dueDate={task.dueDate} done={task.status === "done"} />
            )}
          </div>

          <section>
            <h3 style={sectionLabel}>Description</h3>
            {editingDesc && canEditAll ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                <textarea
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={6}
                  maxLength={TASK_FIELD_LIMITS.description}
                  style={{
                    width: "100%",
                    padding: "var(--space-3)",
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-md)",
                    color: "var(--color-text)",
                    fontSize: "var(--text-sm)",
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button size="sm" onClick={saveDesc}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDescDraft(task.description);
                      setEditingDesc(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p
                onClick={() => canEditAll && setEditingDesc(true)}
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: "var(--text-sm)",
                  color: task.description ? "var(--color-text)" : "var(--color-text-muted)",
                  cursor: canEditAll ? "text" : "default",
                  padding: "var(--space-3)",
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  minHeight: "3rem",
                }}
              >
                {task.description || (canEditAll ? "Click to add a description…" : "No description.")}
              </p>
            )}
          </section>

          <section>
            <h3 style={sectionLabel}>
              Subtasks{" "}
              {task.subtaskStats.total > 0 && (
                <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>
                  ({task.subtaskStats.done}/{task.subtaskStats.total})
                </span>
              )}
            </h3>
            {task.subtaskStats.total > 0 && (
              <div style={{ marginBottom: "var(--space-2)" }}>
                <ProgressBar
                  value={task.subtaskStats.done}
                  max={task.subtaskStats.total}
                  tone={task.subtaskStats.done === task.subtaskStats.total ? "success" : "accent"}
                />
              </div>
            )}
            <SubtaskList task={task} users={users} canEdit={canEditProgressFields} />
          </section>

          <section>
            <h3 style={sectionLabel}>Attachments</h3>
            <AttachmentsSection
              taskId={task.id}
              users={users}
              viewerUid={viewerUid}
              viewerIsAdmin={isAdmin}
              canParticipate={canEditProgressFields}
            />
          </section>

          <section>
            <h3 style={sectionLabel}>Discussion</h3>
            <CommentThread
              task={task}
              users={users}
              viewerUid={viewerUid}
              viewerIsAdmin={isAdmin}
              canParticipate={canEditProgressFields}
            />
          </section>
        </div>

        {/* Sidebar */}
        <div
          style={{
            padding: "var(--space-5)",
            background: "var(--color-bg-elevated)",
            borderLeft: "1px solid var(--color-border)",
            overflowY: "auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-5)",
          }}
        >
          {canEditAll && (
            <div>
              <h4 style={sectionLabel}>Project</h4>
              <Select
                value={task.projectId ?? ""}
                onChange={(e) => onProjectChange(e.target.value)}
              >
                <option value="">— none —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {!canEditAll && project && (
            <div>
              <h4 style={sectionLabel}>Project</h4>
              <Badge tone="accent">{project.name}</Badge>
            </div>
          )}

          <div>
            <h4 style={sectionLabel}>Completers</h4>
            {canEditAll ? (
              <AssigneePicker
                users={users}
                selected={task.completerUids}
                onChange={onCompletersChange}
                max={TASK_FIELD_LIMITS.maxCompleters}
                role="completer"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                {task.completerUids.length === 0 && (
                  <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                    Unassigned
                  </span>
                )}
                {task.completerUids.map((uid) => {
                  const u = users.find((x) => x.uid === uid);
                  return (
                    <span key={uid} style={{ fontSize: "var(--text-sm)" }}>
                      {u?.displayName ?? u?.email ?? uid}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <h4 style={sectionLabel}>Reviewers</h4>
            {canEditAll ? (
              <AssigneePicker
                users={users}
                selected={task.reviewerUids}
                onChange={onReviewersChange}
                max={TASK_FIELD_LIMITS.maxReviewers}
                role="reviewer"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                {task.reviewerUids.length === 0 && (
                  <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                    No reviewer set
                  </span>
                )}
                {task.reviewerUids.map((uid) => {
                  const u = users.find((x) => x.uid === uid);
                  return (
                    <span key={uid} style={{ fontSize: "var(--text-sm)" }}>
                      {u?.displayName ?? u?.email ?? uid}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {isAdmin && (
            <div>
              <h4 style={sectionLabel}>Visibility</h4>
              <Select
                value={task.visibility}
                onChange={(e) => onVisibilityChange(e.target.value as TaskVisibility)}
              >
                <option value="committee">Committee-visible</option>
                <option value="assignees-only">Private — assignees + admins</option>
              </Select>
            </div>
          )}

          <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <div>
              Created by{" "}
              <strong style={{ color: "var(--color-text)" }}>
                {creator?.displayName ?? creator?.email ?? "—"}
              </strong>
            </div>
            {task.createdAt && <div>On {task.createdAt.toLocaleDateString()}</div>}
            {task.updatedAt && <div>Updated {task.updatedAt.toLocaleString()}</div>}
            <div style={{ textTransform: "capitalize" }}>Source: {task.source.replace("-", " ")}</div>
            <div style={{ textTransform: "capitalize" }}>Kind: {task.kind.replace("-", " ")}</div>
          </div>

          {canEditAll && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <Button size="sm" variant="secondary" onClick={handleArchiveToggle}>
                {task.archived ? "Unarchive" : "Archive"}
              </Button>
              {/* Delete is creator/admin only — matches the Firestore rules,
                  which reject delete from non-creator committee members. */}
              {(isAdmin || isCreator) && (
                <Button size="sm" variant="danger" onClick={handleDelete}>
                  Delete task
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * Small local wrapper so the AttachmentList/Upload hook call (useTaskAttachments)
 * is colocated with the section that uses it — keeps the main modal body
 * uncluttered and avoids lifting attachment state higher than needed.
 */
function AttachmentsSection({
  taskId,
  users,
  viewerUid,
  viewerIsAdmin,
  canParticipate,
}: {
  taskId: string;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  canParticipate: boolean;
}) {
  const { attachments, loading } = useTaskAttachments(taskId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {loading ? (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
          Loading attachments…
        </p>
      ) : (
        <AttachmentList
          taskId={taskId}
          attachments={attachments}
          users={users}
          viewerUid={viewerUid}
          viewerIsAdmin={viewerIsAdmin}
        />
      )}
      {canParticipate && <AttachmentUpload taskId={taskId} />}
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--color-text-muted)",
  marginBottom: "var(--space-2)",
  fontWeight: 600,
};

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--color-text)",
  fontWeight: 500,
};

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          maxWidth: "56rem",
          width: "100%",
          maxHeight: "85vh",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            position: "absolute",
            top: "var(--space-3)",
            right: "var(--space-3)",
            background: "transparent",
            border: "none",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-lg)",
            cursor: "pointer",
            zIndex: 1,
          }}
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}
