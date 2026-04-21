"use client";

import { useMemo, useState } from "react";
import {
  TASK_FIELD_LIMITS,
  isSubtaskBlocked,
  type Subtask,
  type SubtaskRoleHint,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import {
  removeSubtask,
  renameSubtask,
  setSubtaskAssignees,
  setSubtaskBlockedBy,
  setSubtaskReviewers,
  setSubtaskRoleHint,
  toggleSubtask,
} from "../taskMutations";
import AssigneePicker from "./AssigneePicker";

type Props = {
  task: TaskDoc;
  subtask: Subtask;
  users: UserDoc[];
  canEdit: boolean;
  /** Optional drag handle rendered on the left when the row is sortable. */
  dragHandle?: React.ReactNode;
};

export default function SubtaskRow({ task, subtask, users, canEdit, dragHandle }: Props) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);

  const blocked = !subtask.done && isSubtaskBlocked(subtask, task.subtasks);

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
  const blockers = useMemo(
    () =>
      subtask.blockedBy
        .map((id) => task.subtasks.find((s) => s.id === id))
        .filter((s): s is Subtask => Boolean(s)),
    [subtask.blockedBy, task.subtasks],
  );
  const siblings = task.subtasks.filter((s) => s.id !== subtask.id);

  const assignees = useMemo(
    () => subtask.assigneeUids.map((uid) => users.find((u) => u.uid === uid)).filter(Boolean) as UserDoc[],
    [subtask.assigneeUids, users],
  );
  const reviewers = useMemo(
    () => subtask.reviewerUids.map((uid) => users.find((u) => u.uid === uid)).filter(Boolean) as UserDoc[],
    [subtask.reviewerUids, users],
  );

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
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
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

        {subtask.roleHint === "reviewer" && (
          <span
            title="Peer-review step"
            style={{
              fontSize: "var(--text-xs)",
              padding: "0.1rem 0.5rem",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-warning-soft, var(--color-surface-hover))",
              color: "var(--color-warning, var(--color-text-muted))",
            }}
          >
            review
          </span>
        )}

        <InlineAvatars users={assignees} tone="accent" title="Assignees" />
        <InlineAvatars users={reviewers} tone="warning" title="Reviewers" />

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

          <label style={{ gridColumn: "span 2", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              Role hint
            </span>
            <select
              value={subtask.roleHint ?? ""}
              onChange={(e) =>
                setSubtaskRoleHint(
                  task,
                  subtask.id,
                  (e.target.value || null) as SubtaskRoleHint,
                ).catch(console.error)
              }
              style={{
                padding: "0.3rem 0.5rem",
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                color: "var(--color-text)",
                fontSize: "var(--text-xs)",
              }}
            >
              <option value="">None</option>
              <option value="completer">Completer step</option>
              <option value="reviewer">Reviewer step</option>
            </select>
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
              label="Reviewers on this step"
              max={TASK_FIELD_LIMITS.maxReviewersPerSubtask}
              role="reviewer"
            />
          </div>

          {siblings.length > 0 && (
            <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                Blocked by (must be done first)
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
