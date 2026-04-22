"use client";

import { useMemo, useState } from "react";
import {
  TASK_FIELD_LIMITS,
  effectiveReviewerUids,
  getSubtaskApprovalStatus,
  isSubtaskBlocked,
  subtaskRowState,
  type RowState,
  type Subtask,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import {
  removeSubtask,
  renameSubtask,
  setSubtaskApproval,
  setSubtaskAssignees,
  setSubtaskBlockedBy,
  setSubtaskReviewers,
  toggleSubtask,
  type ReviewState,
} from "../taskMutations";
import AssigneePicker from "./AssigneePicker";

type Props = {
  task: TaskDoc;
  subtask: Subtask;
  users: UserDoc[];
  viewerUid: string;
  canEdit: boolean;
  /** Whether the viewer can see the reviewer columns. Completers + non-
   *  involved committee members get this `false` — they see the row's
   *  aggregate colour state but not the per-reviewer grid. */
  showMatrix: boolean;
  /** True when a sent_for_review is pending resolution for this specific
   *  subtask (derived in the parent from the activity feed). Drives the
   *  orange row tint while approvals are incoming. */
  isReviewPending: boolean;
  /** Optional drag handle rendered on the left when the row is sortable. */
  dragHandle?: React.ReactNode;
};

const ROW_COLOURS: Record<RowState, { border: string; bg: string | null }> = {
  neutral: { border: "var(--color-border)", bg: null },
  blue: { border: "var(--color-accent)", bg: "var(--color-accent-soft)" },
  orange: {
    border: "var(--color-warning, var(--color-accent))",
    bg: "var(--color-warning-soft, var(--color-surface-hover))",
  },
  green: {
    border: "var(--color-success, #16a34a)",
    bg: "var(--color-success-soft, rgba(22, 163, 74, 0.08))",
  },
};

export default function SubtaskRow({
  task,
  subtask,
  users,
  viewerUid,
  canEdit,
  showMatrix,
  isReviewPending,
  dragHandle,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);

  const blocked = !subtask.done && isSubtaskBlocked(subtask, task.subtasks, task.reviewerUids);
  const blockers = useMemo(
    () =>
      subtask.blockedBy
        .map((id) => task.subtasks.find((s) => s.id === id))
        .filter((s): s is Subtask => Boolean(s)),
    [subtask.blockedBy, task.subtasks],
  );
  const siblings = task.subtasks.filter((s) => s.id !== subtask.id);

  const assignees = useMemo(
    () =>
      subtask.assigneeUids
        .map((uid) => users.find((u) => u.uid === uid))
        .filter((u): u is UserDoc => Boolean(u)),
    [subtask.assigneeUids, users],
  );

  const reviewers = useMemo(() => {
    const uids = effectiveReviewerUids(subtask, task.reviewerUids);
    return uids
      .map((uid) => users.find((u) => u.uid === uid) ?? { uid, displayName: null, email: null, role: "member" } as UserDoc)
      .filter(Boolean) as UserDoc[];
  }, [subtask, task.reviewerUids, users]);

  const approvalStatus = useMemo(
    () => getSubtaskApprovalStatus(subtask, task.reviewerUids),
    [subtask, task.reviewerUids],
  );

  const rowState = subtaskRowState(subtask, task.reviewerUids, isReviewPending);
  const rowPalette = ROW_COLOURS[rowState];

  async function handleDelete() {
    const ok = window.confirm(
      `Delete subtask "${subtask.title}"? This also clears any other subtask's dependency on it.`,
    );
    if (!ok) return;
    try {
      await removeSubtask(task, subtask.id);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleTitleBlur() {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === subtask.title) {
      setTitleDraft(subtask.title);
      return;
    }
    try {
      await renameSubtask(task, subtask.id, trimmed);
    } catch (err) {
      console.error(err);
      setTitleDraft(subtask.title);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "0.85rem 1rem",
        background: rowPalette.bg ?? "var(--color-bg-elevated)",
        border: `1px solid ${rowPalette.border}`,
        borderLeftWidth: "3px",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minHeight: "2rem" }}>
        {dragHandle}
        <input
          type="checkbox"
          checked={subtask.done}
          disabled={blocked}
          onChange={() => toggleSubtask(task, subtask.id).catch(console.error)}
          aria-label={
            blocked
              ? `Blocked — waiting on ${blockers.map((b) => b.title).join(", ") || "earlier subtask"}`
              : `Mark "${subtask.title}" ${subtask.done ? "incomplete" : "complete"}`
          }
          title={
            blocked
              ? `Waiting on: ${blockers.map((b) => b.title).join(", ") || "earlier subtask"}`
              : undefined
          }
        />
        <span
          style={{
            flex: 1,
            fontSize: "var(--text-sm)",
            textDecoration: subtask.done ? "line-through" : "none",
            color: subtask.done ? "var(--color-text-muted)" : "var(--color-text)",
          }}
        >
          {subtask.title}
        </span>

        <InlineAvatars users={assignees} tone="accent" title="Assignees" />

        {showMatrix && reviewers.length > 0 && (
          <ApprovalMatrixRow
            reviewers={reviewers}
            approvedUids={subtask.approvedByReviewerUids}
            questionedUids={subtask.questionedByReviewerUids}
            viewerUid={viewerUid}
            onSet={(state) =>
              setSubtaskApproval(task, subtask.id, state).catch(console.error)
            }
          />
        )}

        {canEdit && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginLeft: "var(--space-2)" }}>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              aria-label={editing ? "Close subtask editor" : "Edit subtask"}
              style={{
                background: "transparent",
                border: "none",
                color: editing ? "var(--color-accent)" : "var(--color-text-muted)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
                fontWeight: 500,
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--radius-sm, 4px)",
              }}
            >
              {editing ? "Done" : "Edit"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              aria-label={`Delete subtask "${subtask.title}"`}
              title="Delete subtask"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-danger)",
                cursor: "pointer",
                fontSize: "var(--text-sm)",
                fontWeight: 600,
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--radius-sm, 4px)",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {blocked && blockers.length > 0 && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            fontWeight: 500,
            color: "var(--color-warning, var(--color-text))",
          }}
        >
          Waiting on: {blockers.map((b) => b.title).join(" • ")}
        </p>
      )}

      {showMatrix && approvalStatus.required.length > 0 && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
          }}
        >
          {approvalStatus.approved.length} / {approvalStatus.required.length} approved
          {approvalStatus.questioned.length > 0 &&
            ` · ${approvalStatus.questioned.length} open question${approvalStatus.questioned.length === 1 ? "" : "s"}`}
        </p>
      )}

      {editing && canEdit && (
        <div
          style={{
            display: "grid",
            gap: "var(--space-3)",
            gridTemplateColumns: "1fr 1fr",
            marginTop: "var(--space-2)",
            paddingTop: "var(--space-2)",
            borderTop: "1px dashed var(--color-border)",
          }}
        >
          <label style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              Title
            </span>
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleBlur}
              maxLength={TASK_FIELD_LIMITS.subtaskTitle}
              style={{
                padding: "0.4rem 0.6rem",
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                color: "var(--color-text)",
                fontSize: "var(--text-sm)",
              }}
            />
          </label>

          <div>
            <AssigneePicker
              users={users}
              selected={subtask.assigneeUids}
              onChange={(uids) => setSubtaskAssignees(task, subtask.id, uids).catch(console.error)}
              label="Assignees on this step"
              max={TASK_FIELD_LIMITS.maxAssigneesPerSubtask}
              role="completer"
            />
          </div>
          <div>
            <AssigneePicker
              users={users}
              selected={subtask.reviewerUids}
              onChange={(uids) => setSubtaskReviewers(task, subtask.id, uids).catch(console.error)}
              label="Reviewers (leave empty to inherit from task)"
              max={TASK_FIELD_LIMITS.maxReviewersPerSubtask}
              role="reviewer"
            />
          </div>

          {siblings.length > 0 && (
            <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                Blocked by (must be done + approved first)
              </span>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                  padding: "var(--space-2)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--color-bg)",
                }}
              >
                {siblings.map((sib) => {
                  const checked = subtask.blockedBy.includes(sib.id);
                  return (
                    <label
                      key={sib.id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        fontSize: "var(--text-xs)",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? subtask.blockedBy.filter((id) => id !== sib.id)
                            : [...subtask.blockedBy, sib.id];
                          setSubtaskBlockedBy(task, subtask.id, next).catch(console.error);
                        }}
                      />
                      <span style={{ color: "var(--color-text-muted)" }}>{sib.title}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InlineAvatars({
  users,
  tone,
  title,
}: {
  users: UserDoc[];
  tone: "accent" | "warning";
  title: string;
}) {
  if (users.length === 0) return null;
  const bg = tone === "warning"
    ? "var(--color-warning-soft, var(--color-surface-hover))"
    : "var(--color-accent-soft)";
  const fg = tone === "warning"
    ? "var(--color-warning, var(--color-text))"
    : "var(--color-accent)";
  return (
    <span
      title={`${title}: ${users.map((u) => u.displayName ?? u.email ?? u.uid).join(", ")}`}
      style={{ display: "inline-flex", gap: "2px" }}
    >
      {users.slice(0, 3).map((u) => (
        <span
          key={u.uid}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "1.25rem",
            height: "1.25rem",
            borderRadius: "50%",
            background: bg,
            color: fg,
            fontSize: "10px",
            fontWeight: 600,
          }}
        >
          {(u.displayName ?? u.email ?? "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {users.length > 3 && (
        <span style={{ fontSize: "10px", color: "var(--color-text-subtle)" }}>+{users.length - 3}</span>
      )}
    </span>
  );
}

/**
 * Per-reviewer approval cells on a subtask row. Each cell shows the
 * current state (empty / ❓ / ✓) for one reviewer. Only the viewer's own
 * cell is clickable; others render as read-only status icons.
 */
function ApprovalMatrixRow({
  reviewers,
  approvedUids,
  questionedUids,
  viewerUid,
  onSet,
}: {
  reviewers: UserDoc[];
  approvedUids: string[];
  questionedUids: string[];
  viewerUid: string;
  onSet: (state: ReviewState) => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: "var(--space-1)",
        padding: "2px 4px",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm, 4px)",
        background: "var(--color-bg)",
      }}
    >
      {reviewers.map((r) => {
        const state: "approved" | "question" | "empty" = approvedUids.includes(r.uid)
          ? "approved"
          : questionedUids.includes(r.uid)
            ? "question"
            : "empty";
        const isMine = r.uid === viewerUid;
        return (
          <ApprovalCell
            key={r.uid}
            reviewer={r}
            state={state}
            isMine={isMine}
            onSet={onSet}
          />
        );
      })}
    </span>
  );
}

function ApprovalCell({
  reviewer,
  state,
  isMine,
  onSet,
}: {
  reviewer: UserDoc;
  state: "approved" | "question" | "empty";
  isMine: boolean;
  onSet: (state: ReviewState) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = reviewer.displayName ?? reviewer.email ?? reviewer.uid;
  const initial = label.charAt(0).toUpperCase();

  const icon =
    state === "approved" ? "✓" : state === "question" ? "❓" : initial;
  const color =
    state === "approved"
      ? "var(--color-success, #16a34a)"
      : state === "question"
        ? "var(--color-warning, var(--color-accent))"
        : "var(--color-text-subtle)";
  const bg =
    state === "approved"
      ? "var(--color-success-soft, rgba(22, 163, 74, 0.12))"
      : state === "question"
        ? "var(--color-warning-soft, var(--color-surface-hover))"
        : "transparent";

  if (!isMine) {
    return (
      <span
        title={`${label}: ${state === "empty" ? "not yet reviewed" : state === "approved" ? "approved" : "has a question"}`}
        aria-label={`${label} ${state}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.5rem",
          height: "1.5rem",
          borderRadius: "var(--radius-sm, 4px)",
          background: bg,
          color,
          fontSize: "10px",
          fontWeight: 700,
          cursor: "default",
        }}
      >
        {icon}
      </span>
    );
  }

  return (
    <span style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Your review of this subtask — ${state === "empty" ? "click to set" : `currently ${state}`}`}
        aria-label={`Set your review state (currently ${state})`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.5rem",
          height: "1.5rem",
          borderRadius: "var(--radius-sm, 4px)",
          background: bg,
          color,
          fontSize: "10px",
          fontWeight: 700,
          border: "1px solid var(--color-border)",
          cursor: "pointer",
        }}
      >
        {icon}
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 5,
            minWidth: "9rem",
            padding: "0.25rem",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
          }}
        >
          <ApprovalMenuItem
            icon="✓"
            label="Approve"
            onClick={() => {
              onSet("approve");
              setOpen(false);
            }}
            active={state === "approved"}
          />
          <ApprovalMenuItem
            icon="❓"
            label="Have question"
            onClick={() => {
              onSet("question");
              setOpen(false);
            }}
            active={state === "question"}
          />
          <ApprovalMenuItem
            icon="⬜"
            label="Clear"
            onClick={() => {
              onSet("clear");
              setOpen(false);
            }}
            active={state === "empty"}
          />
        </div>
      )}
    </span>
  );
}

function ApprovalMenuItem({
  icon,
  label,
  onClick,
  active,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0.3rem 0.55rem",
        background: active ? "var(--color-surface-hover)" : "transparent",
        color: "var(--color-text)",
        border: "none",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
        textAlign: "left",
        borderRadius: "var(--radius-sm, 4px)",
      }}
    >
      <span style={{ width: "1rem", textAlign: "center" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
