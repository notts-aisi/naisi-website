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
  canMarkTaskDone,
  getSubtaskApprovalStatus,
  type TaskDoc,
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
import { useCommentsAndActivity } from "../hooks/useCommentsAndActivity";
import { useTaskAttachments } from "../hooks/useTaskAttachments";
import type { ActivityDoc } from "@/lib/firestore/taskActivity";

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
  const { feed, activity, loading: feedLoading } = useCommentsAndActivity(taskId);
  const isAdmin = viewerRole === "admin";
  const isCommittee = viewerRole === "committee" || viewerRole === "admin";
  const isCompleter = task ? task.completerUids.includes(viewerUid) : false;
  const isTaskReviewer = task ? task.reviewerUids.includes(viewerUid) : false;
  // A viewer is a reviewer if they're on task-level reviewerUids OR on any
  // subtask's per-row reviewerUids. This governs matrix visibility.
  const isAnyReviewer =
    isTaskReviewer ||
    (task?.subtasks.some((s) => s.reviewerUids.includes(viewerUid)) ?? false);
  const isCreator = task ? task.creatorUid === viewerUid : false;
  const canEditAll =
    !!task &&
    (isAdmin ||
      (isCommittee && task.visibility === "committee") ||
      (task.source === "personal" && isCreator));
  // Completers and reviewers both can tick subtasks and change status.
  // Reviewers in this band is what lets them tick their review step even if
  // they're not on the completer list.
  const canEditProgressFields = canEditAll || isCompleter || isAnyReviewer;
  // Matrix + reviewer section visibility: admin + creator + any reviewer.
  // Completers who aren't also reviewers see the row state colours only, not
  // the per-reviewer columns or the reviewer picker.
  const canSeeReviewerSection = isAdmin || isCreator || isAnyReviewer;

  // Pending sent_for_review — derive from activity so SubtaskRow can tint
  // pending rows orange and the composer can gate its own button. Task-level
  // pending is used for the Done-status disable logic; subtask-level is per-row.
  // pendingTaskReview is computed here too (the helper returns both halves),
  // but right now only pendingSubtaskIds is consumed — for row tinting. The
  // task-level pending is surfaced in the CommentComposer via its own local
  // derivation. Leaving the helper returning both so Phase 3 (which will
  // also disable the Done option while a task-level review is outstanding)
  // doesn't have to refactor.
  const { pendingSubtaskIds } = computePendingReview(activity, task);
  const doneGate = task ? canMarkTaskDone(task) : { ok: false, reason: null };
  // Status = "done" is reviewer/admin/creator-only on tasks with reviewers.
  // Reviewer-less tasks fall back to admin + creator.
  const canMarkDone = task
    ? task.reviewerUids.length > 0
      ? isAdmin || isTaskReviewer || isCreator
      : isAdmin || isCreator
    : false;

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
                title={
                  !canMarkDone && task.status !== "done"
                    ? "Only a reviewer, admin, or creator (on reviewer-less tasks) can mark Done"
                    : !doneGate.ok
                      ? (doneGate.reason ?? undefined)
                      : undefined
                }
              >
                {TASK_STATUSES.map((s) => (
                  <option
                    key={s}
                    value={s}
                    // Block "done" when (a) viewer isn't eligible, or
                    // (b) the per-subtask + global coverage gates aren't met.
                    // Always allow the current value to render so the select
                    // doesn't show a phantom option when already "done".
                    disabled={
                      s === "done" &&
                      task.status !== "done" &&
                      (!canMarkDone || !doneGate.ok)
                    }
                  >
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
            {canSeeReviewerSection && task.reviewerUids.length > 0 && (
              <ReviewerProgressSummary task={task} users={users} />
            )}
            <SubtaskList
              task={task}
              users={users}
              viewerUid={viewerUid}
              canEdit={canEditProgressFields}
              showMatrix={canSeeReviewerSection}
              pendingReviewSubtaskIds={pendingSubtaskIds}
            />
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
              feed={feed}
              activity={activity}
              feedLoading={feedLoading}
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

          {/* Reviewer picker + read-only list are hidden from completers
              and non-involved committee. Admin, creator, and anyone who's
              actually a reviewer on this task see it. */}
          {canSeeReviewerSection && (
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
          )}

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

/**
 * Summary strip above the subtask list: "Alice 3/4 ✓ · Bob 2/4 ✓ (1 ?)".
 * Only rendered when the viewer can see the matrix (admin / creator / reviewer).
 */
function ReviewerProgressSummary({
  task,
  users,
}: {
  task: TaskDoc;
  users: UserDoc[];
}) {
  const stats = task.reviewerUids.map((uid) => {
    let approvedCount = 0;
    let questionCount = 0;
    let totalRequired = 0;
    for (const s of task.subtasks) {
      const status = getSubtaskApprovalStatus(s, task.reviewerUids);
      if (!status.required.includes(uid)) continue;
      totalRequired += 1;
      if (status.approved.includes(uid)) approvedCount += 1;
      else if (status.questioned.includes(uid)) questionCount += 1;
    }
    const user = users.find((u) => u.uid === uid);
    const name = user?.displayName ?? user?.email ?? uid;
    return { uid, name, approvedCount, questionCount, totalRequired };
  });
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--space-3)",
        padding: "0.5rem 0.75rem",
        marginBottom: "var(--space-2)",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--text-xs)",
      }}
    >
      {stats.map((s) => {
        const done = s.totalRequired > 0 && s.approvedCount === s.totalRequired;
        return (
          <span
            key={s.uid}
            style={{
              color: done
                ? "var(--color-success, #16a34a)"
                : s.questionCount > 0
                  ? "var(--color-warning, var(--color-text))"
                  : "var(--color-text-muted)",
            }}
          >
            <strong style={{ color: "var(--color-text)" }}>{s.name}</strong>{" "}
            {s.approvedCount}/{s.totalRequired} ✓
            {s.questionCount > 0 && ` (${s.questionCount} ?)`}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Walk the activity stream to find the latest `sent_for_review` per target
 * (subtask id, or null for task-level). A target is considered "pending"
 * until its resolution event — subtask done, or task status = done.
 */
function computePendingReview(
  activity: ActivityDoc[],
  task: TaskDoc | null,
): { pendingTaskReview: boolean; pendingSubtaskIds: Set<string> } {
  if (!task) return { pendingTaskReview: false, pendingSubtaskIds: new Set() };
  let latestTask: ActivityDoc | null = null;
  const latestBySubtask = new Map<string, ActivityDoc>();
  for (const a of activity) {
    if (a.kind !== "sent_for_review") continue;
    const subId =
      typeof a.payload?.subtaskId === "string" ? (a.payload.subtaskId as string) : null;
    if (subId === null) {
      if (!latestTask || (a.createdAt?.getTime() ?? 0) > (latestTask.createdAt?.getTime() ?? 0)) {
        latestTask = a;
      }
    } else {
      const prev = latestBySubtask.get(subId);
      if (!prev || (a.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) {
        latestBySubtask.set(subId, a);
      }
    }
  }
  const pendingTaskReview = Boolean(latestTask && task.status !== "done");
  const pendingSubtaskIds = new Set<string>();
  for (const [subId] of latestBySubtask) {
    const sub = task.subtasks.find((s) => s.id === subId);
    if (sub && !sub.done) pendingSubtaskIds.add(subId);
  }
  return { pendingTaskReview, pendingSubtaskIds };
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
