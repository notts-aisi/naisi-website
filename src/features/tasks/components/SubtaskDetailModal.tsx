"use client";

import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import {
  TASK_FIELD_LIMITS,
  effectiveReviewerUids,
  getSubtaskApprovalStatus,
  type Subtask,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import { updateSubtaskDescription, updateSubtaskDueDate } from "../taskMutations";
import { addComment, updateComment } from "../commentMutations";
import { extractMentionUids } from "../lib/comments/markdown";
import { useSubtaskComments } from "../hooks/useSubtaskComments";
import { useSubtaskActivity } from "../hooks/useSubtaskActivity";
import { useTaskAttachments } from "../hooks/useTaskAttachments";
import CommentItem from "./CommentItem";
import CommentEditor from "./CommentEditor";
import AttachmentList from "./AttachmentList";
import AttachmentUpload from "./AttachmentUpload";
import DescriptionEditor from "./DescriptionEditor";
import RichTextRender from "./RichTextRender";
import TaskCalendar from "./TaskCalendar";
import type { ActivityDoc } from "@/lib/firestore/taskActivity";
import styles from "./SubtaskDetailModal.module.css";

type Props = {
  task: TaskDoc;
  subtask: Subtask;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  /** True when the viewer can edit this subtask's description. Mirrors the
   *  `canEditStructure` permission on the surrounding task — admin or
   *  committee on committee tasks, or creator on personal tasks. */
  canEditDescription: boolean;
  /** True when the viewer can edit due dates. Stricter than
   *  `canEditDescription` — admin / creator / task-level reviewer only.
   *  Completers (even committee ones) can't move dates. */
  canEditDueDates: boolean;
  /** True when the viewer can post subcomments. Task participants
   *  (completer/reviewer/admin/creator) can; outside viewers see the
   *  thread read-only. */
  canComment: boolean;
  onClose: () => void;
};

function toDateInputValue(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function SubtaskDetailModal({
  task,
  subtask,
  users,
  viewerUid,
  viewerIsAdmin,
  canEditDescription,
  canEditDueDates,
  canComment,
  onClose,
}: Props) {
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(subtask.description);
  const [saving, setSaving] = useState(false);
  const [dueBusy, setDueBusy] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);

  // Mention pool = the task's current roster. Previous completers / reviewers
  // who were removed shouldn't surface in the dropdown. See CommentComposer
  // for the same filter applied to task-level comments.
  const mentionableUsers = useMemo(() => {
    const roster = new Set<string>([...task.completerUids, ...task.reviewerUids]);
    return users.filter((u) => roster.has(u.uid));
  }, [users, task.completerUids, task.reviewerUids]);

  const { comments: subComments, loading: subCommentsLoading } = useSubtaskComments(
    task.id,
    subtask.id,
  );
  const { entries: subActivity } = useSubtaskActivity(task.id, subtask.id);

  function beginEdit(commentId: string) {
    setEditingCommentId(commentId);
  }

  async function postSubComment(body: string, mentions: string[]) {
    const commentId = await addComment({
      taskId: task.id,
      bodyMarkdown: body,
      mentions,
      subtaskId: subtask.id,
    });
    // Held-back wiring (2026-04-26): subcomment pings now fire through
    // the same /notify route as task-level mentions, scoped to the
    // subtask so the email subject reads "commented on subtask X".
    // Fire-and-forget; the comment doc has already persisted.
    if (mentions.length > 0) {
      fireNotify(task.id, {
        commentId,
        subtaskId: subtask.id,
      });
    }
  }

  async function saveEdit(body: string, mentions: string[]) {
    if (!editingCommentId) return;
    const previousBody =
      subComments.find((c) => c.id === editingCommentId)?.bodyMarkdown ?? "";
    await updateComment(task.id, editingCommentId, body, mentions);
    setEditingCommentId(null);
    // Edit-fires-only-on-newly-added-mentions semantics, mirroring the
    // task-level CommentComposer. priorMentions stops the route from
    // re-emailing names that were already pinged in the original.
    const priorMentions = extractMentionUids(previousBody);
    const addedMentions = mentions.filter((u) => !priorMentions.includes(u));
    if (addedMentions.length > 0) {
      fireNotify(task.id, {
        commentId: editingCommentId,
        subtaskId: subtask.id,
        priorMentions,
      });
    }
  }

  function fireNotify(taskId: string, payload: Record<string, unknown>): void {
    fetch(`/api/tasks/${taskId}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch((err) => console.warn("subcomment notify failed:", err));
  }

  // Sync the draft if the underlying subtask changes (e.g. another writer
  // edited the description while this modal was open).
  const [syncedKey, setSyncedKey] = useState(
    `${subtask.id}:${subtask.description}`,
  );
  const liveKey = `${subtask.id}:${subtask.description}`;
  if (liveKey !== syncedKey && !editingDesc) {
    setSyncedKey(liveKey);
    setDescDraft(subtask.description);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const assignees = subtask.assigneeUids
    .map((uid) => users.find((u) => u.uid === uid))
    .filter((u): u is UserDoc => Boolean(u));
  const reviewerUids = effectiveReviewerUids(subtask, task.reviewerUids);
  const approvalStatus = getSubtaskApprovalStatus(subtask, task.reviewerUids);

  async function saveDesc() {
    if (descDraft.length > TASK_FIELD_LIMITS.subtaskDescription) {
      window.alert(
        `Description is too long (${descDraft.length}/${TASK_FIELD_LIMITS.subtaskDescription}). Trim before saving.`,
      );
      return;
    }
    if (descDraft === subtask.description) {
      setEditingDesc(false);
      return;
    }
    setSaving(true);
    try {
      await updateSubtaskDescription(task, subtask.id, descDraft);
      setEditingDesc(false);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Couldn't save description");
    } finally {
      setSaving(false);
    }
  }

  async function onDueChange(value: string) {
    const next = value ? new Date(value) : null;
    setDueBusy(true);
    try {
      await updateSubtaskDueDate(task, subtask.id, next);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Couldn't save due date");
    } finally {
      setDueBusy(false);
    }
  }

  const now = new Date();
  const isOverdue =
    subtask.dueDate !== null && !subtask.done && subtask.dueDate.getTime() < now.getTime();

  return (
    <Overlay onClose={onClose}>
      <div className={styles.body}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <h2
            style={{
              fontSize: "var(--text-lg)",
              fontWeight: 600,
              margin: 0,
              flex: 1,
              textDecoration: subtask.done ? "line-through" : "none",
              color: subtask.done ? "var(--color-text-muted)" : "var(--color-text)",
            }}
          >
            {subtask.title}
          </h2>
          {subtask.roleHint === "reviewer" && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: "999px",
                background: "var(--color-warning-soft, var(--color-surface-hover))",
                color: "var(--color-warning, var(--color-text))",
                fontSize: "10px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Reviewer signoff
            </span>
          )}
        </div>

        <section>
          <h3 style={sectionLabel}>Description</h3>
          {editingDesc && canEditDescription ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <DescriptionEditor
                editorKey={`subtask-desc:${task.id}:${subtask.id}`}
                initialBody={subtask.description}
                onChange={setDescDraft}
                autoFocus
                minHeightRem={8}
                disabled={saving}
              />
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <Button size="sm" onClick={saveDesc} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDescDraft(subtask.description);
                    setEditingDesc(false);
                  }}
                >
                  Cancel
                </Button>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "var(--text-xs)",
                    color:
                      descDraft.length > TASK_FIELD_LIMITS.subtaskDescription
                        ? "var(--color-danger, #dc2626)"
                        : "var(--color-text-muted)",
                  }}
                >
                  {descDraft.length} / {TASK_FIELD_LIMITS.subtaskDescription}
                </span>
              </div>
            </div>
          ) : (
            <div
              onClick={() => canEditDescription && setEditingDesc(true)}
              style={{
                fontSize: "var(--text-sm)",
                color: subtask.description
                  ? "var(--color-text)"
                  : "var(--color-text-muted)",
                cursor: canEditDescription ? "text" : "default",
                padding: "var(--space-3)",
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                minHeight: "4rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {subtask.description ? (
                <RichTextRender body={subtask.description} />
              ) : canEditDescription ? (
                "Click to add instructions, suggested flow, or acceptance cues…"
              ) : (
                "No description provided."
              )}
            </div>
          )}
        </section>

        {/* Reviewer-signoff rows are auto-spawned — their deadline follows
            the block, not an independent due date. Hide the section
            entirely so nobody (including committee editors) can set one. */}
        {subtask.roleHint !== "reviewer" && (
          <section>
            <h3 style={sectionLabel}>Due date</h3>
            <TaskCalendar
              mode={canEditDueDates ? "edit" : "view"}
              value={subtask.dueDate}
              disabled={dueBusy}
              isOverdue={isOverdue}
              collapsible
              onChange={(date) => onDueChange(date ? toDateInputValue(date) : "")}
            />
          </section>
        )}

        <section>
          <h3 style={sectionLabel}>Assignees</h3>
          {assignees.length === 0 ? (
            <p style={emptyHint}>
              {subtask.assigneeUids.length === 0
                ? "Open to any completer on the task."
                : "Unknown user(s) assigned."}
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {assignees.map((u) => (
                <span key={u.uid} style={assigneeChip}>
                  {u.displayName ?? u.email ?? u.uid}
                </span>
              ))}
            </div>
          )}
        </section>

        {subtask.roleHint !== "reviewer" && reviewerUids.length > 0 && (
          <section>
            <h3 style={sectionLabel}>Review state</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
              {reviewerUids.map((uid) => {
                const u = users.find((x) => x.uid === uid);
                const name = u?.displayName ?? u?.email ?? uid;
                const approved = approvalStatus.approved.includes(uid);
                const questioned = approvalStatus.questioned.includes(uid);
                const rejected = approvalStatus.rejected.includes(uid);
                const label = rejected
                  ? "✗ Rejected"
                  : questioned
                    ? "? Question"
                    : approved
                      ? "✓ Approved"
                      : "Pending";
                const colour = rejected
                  ? "var(--color-danger, #dc2626)"
                  : questioned
                    ? "var(--color-warning, var(--color-text))"
                    : approved
                      ? "var(--color-success, #16a34a)"
                      : "var(--color-text-muted)";
                return (
                  <span
                    key={uid}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "0.25rem 0.6rem",
                      background: "var(--color-bg-elevated)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "999px",
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    <strong style={{ color: "var(--color-text)" }}>{name}</strong>
                    <span style={{ color: colour }}>{label}</span>
                  </span>
                );
              })}
            </div>
          </section>
        )}

        <SubtaskAttachmentsSection
          task={task}
          subtaskId={subtask.id}
          users={users}
          viewerUid={viewerUid}
          viewerIsAdmin={viewerIsAdmin}
          canUpload={canComment}
        />

        <section>
          <h3 style={sectionLabel}>Activity &amp; comments</h3>
          {(() => {
            type Entry =
              | { kind: "comment"; at: Date | null; payload: (typeof subComments)[number] }
              | { kind: "activity"; at: Date | null; payload: ActivityDoc };
            const rows: Entry[] = [];
            for (const c of subComments) {
              rows.push({ kind: "comment", at: c.createdAt, payload: c });
            }
            for (const a of subActivity) {
              // Skip comment_added — the comment itself already renders.
              if (a.kind === "comment_added") continue;
              rows.push({ kind: "activity", at: a.createdAt, payload: a });
            }
            rows.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
            if (subCommentsLoading && rows.length === 0) {
              return <p style={emptyHint}>Loading…</p>;
            }
            if (rows.length === 0) {
              return (
                <p style={emptyHint}>
                  No activity on this subtask yet. Use the box below to add a comment.
                </p>
              );
            }
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {rows.map((row, i) =>
                  row.kind === "comment" ? (
                    editingCommentId === row.payload.id ? (
                      <div
                        key={`edit-${row.payload.id}`}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "var(--space-2)",
                          padding: "var(--space-3)",
                          background: "var(--color-bg-elevated)",
                          border: "1px solid var(--color-accent)",
                          borderRadius: "var(--radius-md)",
                        }}
                      >
                        <CommentEditor
                          users={mentionableUsers}
                          editorKey={`edit:${row.payload.id}`}
                          initialBody={row.payload.bodyMarkdown}
                          submitLabel="Save"
                          busyLabel="Saving…"
                          autoFocus
                          clearOnSubmit={false}
                          onSubmit={saveEdit}
                          onCancel={() => setEditingCommentId(null)}
                        />
                      </div>
                    ) : (
                      <CommentItem
                        key={`c-${row.payload.id}`}
                        taskId={task.id}
                        comment={row.payload}
                        users={users}
                        viewerUid={viewerUid}
                        viewerIsAdmin={viewerIsAdmin}
                        onEditRequested={beginEdit}
                      />
                    )
                  ) : (
                    <ActivityLine
                      key={`a-${row.payload.id}-${i}`}
                      entry={row.payload}
                      users={users}
                    />
                  ),
                )}
              </div>
            );
          })()}
          {canComment && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <CommentEditor
                users={mentionableUsers}
                editorKey={`new:${subtask.id}`}
                onSubmit={postSubComment}
              />
            </div>
          )}
        </section>
      </div>
    </Overlay>
  );
}

/**
 * Subtask-scoped attachments section. Reuses the task-level hook and filters
 * down to attachments whose `subtaskId` matches this row — task-level
 * attachments (subtaskId === null) render in `TaskDetailModal` instead, so
 * the same artefact never double-shows. Upload is gated on `canUpload`
 * (currently mirrors `canComment`: task participants only).
 */
function SubtaskAttachmentsSection({
  task,
  subtaskId,
  users,
  viewerUid,
  viewerIsAdmin,
  canUpload,
}: {
  task: TaskDoc;
  subtaskId: string;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  canUpload: boolean;
}) {
  const { attachments } = useTaskAttachments(task.id);
  const scoped = attachments.filter((a) => a.subtaskId === subtaskId);
  return (
    <section>
      <h3 style={sectionLabel}>Attachments</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <AttachmentList
          taskId={task.id}
          attachments={scoped}
          users={users}
          viewerUid={viewerUid}
          viewerIsAdmin={viewerIsAdmin}
        />
        {canUpload && <AttachmentUpload taskId={task.id} subtaskId={subtaskId} />}
      </div>
    </section>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--color-text-muted)",
  marginTop: 0,
  marginBottom: "var(--space-2)",
  fontWeight: 600,
};

const emptyHint: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--color-text-muted)",
};

const assigneeChip: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  background: "var(--color-accent-soft)",
  color: "var(--color-accent)",
  borderRadius: "999px",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
};

/**
 * Single-line rendering of a subtask-scoped activity entry (self-add, done,
 * rejected, resubmitted, etc.). Narrow set for the subtask modal — the
 * task-level ActivityFeed handles the broader taxonomy.
 */
function ActivityLine({
  entry,
  users,
}: {
  entry: ActivityDoc;
  users: UserDoc[];
}) {
  const actor = users.find((u) => u.uid === entry.actorUid);
  const actorName = actor?.displayName ?? actor?.email ?? "Someone";
  const verb = summariseActivity(entry, users);
  if (!verb) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--space-2)",
        padding: "0.4rem 0.85rem",
        fontSize: "var(--text-xs)",
        color: "var(--color-text-muted)",
        background: "transparent",
        borderLeft: "2px solid var(--color-border)",
      }}
    >
      <span>
        <strong style={{ color: "var(--color-text)" }}>{actorName}</strong> {verb}
      </span>
      {entry.createdAt && (
        <span style={{ marginLeft: "auto", color: "var(--color-text-subtle)" }}>
          {entry.createdAt.toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
    </div>
  );
}

function summariseActivity(
  entry: ActivityDoc,
  users: UserDoc[],
): string | null {
  const note = typeof entry.payload?.note === "string" ? entry.payload.note : null;
  const withNote = (base: string) =>
    note ? `${base} with note: "${note}"` : base;
  const addedUid =
    typeof entry.payload?.addedUid === "string" ? entry.payload.addedUid : null;
  const removedUid =
    typeof entry.payload?.removedUid === "string" ? entry.payload.removedUid : null;
  const viaBlockSend = entry.payload?.viaBlockSend === true;
  function nameOf(uid: string): string {
    const u = users.find((x) => x.uid === uid);
    return u?.displayName ?? u?.email ?? uid;
  }
  switch (entry.kind) {
    case "subtask_added":
      return "added this subtask";
    case "subtask_done":
      return "marked this subtask done";
    case "subtask_undone":
      return "un-ticked this subtask";
    case "subtask_block_locked_in": {
      const name = typeof entry.payload?.name === "string" ? entry.payload.name : null;
      return name
        ? `locked in block "${name}" — work begins`
        : "locked in the parent block — work begins";
    }
    case "subtask_approved":
      return withNote("approved this subtask");
    case "subtask_questioned":
      return withNote("has a question about this subtask");
    case "subtask_rejected":
      return withNote("rejected this subtask");
    case "subtask_resubmitted":
      return "resubmitted this subtask for review";
    case "subtask_force_sealed":
      return "sealed this subtask (admin)";
    case "subtask_unsealed":
      return "unsealed this subtask (admin)";
    case "sent_for_review":
      return viaBlockSend
        ? "sent this subtask to reviewers (block handoff)"
        : "sent this subtask for review";
    case "assignee_added":
      return addedUid
        ? `added ${nameOf(addedUid)} as an assignee`
        : "added themselves as an assignee";
    case "assignee_removed":
      return removedUid
        ? `removed ${nameOf(removedUid)} as an assignee`
        : "removed themselves as an assignee";
    case "reviewer_added":
      return addedUid
        ? `added ${nameOf(addedUid)} as a reviewer`
        : "added themselves as a reviewer";
    case "reviewer_removed":
      return removedUid
        ? `removed ${nameOf(removedUid)} as a reviewer`
        : "removed themselves as a reviewer";
    case "attachment_added":
      return "uploaded a file";
    case "subtask_blocked_changed":
      return "changed this subtask's dependencies";
    default:
      return null;
  }
}

function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className={styles.overlay}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={styles.panel}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={styles.closeButton}
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}
