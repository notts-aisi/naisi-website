"use client";

import { useEffect, useState } from "react";
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

type Props = {
  task: TaskDoc;
  subtask: Subtask;
  users: UserDoc[];
  /** True when the viewer can edit this subtask's description. Mirrors the
   *  `canEditStructure` permission on the surrounding task — admin or
   *  committee on committee tasks, or creator on personal tasks. */
  canEditDescription: boolean;
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
  canEditDescription,
  onClose,
}: Props) {
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(subtask.description);
  const [saving, setSaving] = useState(false);
  const [dueBusy, setDueBusy] = useState(false);

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
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
          padding: "var(--space-6)",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
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
              <textarea
                autoFocus
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                rows={8}
                maxLength={TASK_FIELD_LIMITS.subtaskDescription}
                placeholder="What's being asked for on this subtask? Acceptance cues, suggested flow, links to context…"
                style={{
                  width: "100%",
                  padding: "var(--space-3)",
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--color-text)",
                  fontSize: "var(--text-sm)",
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
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
                    color: "var(--color-text-muted)",
                  }}
                >
                  {descDraft.length} / {TASK_FIELD_LIMITS.subtaskDescription}
                </span>
              </div>
            </div>
          ) : (
            <p
              onClick={() => canEditDescription && setEditingDesc(true)}
              style={{
                whiteSpace: "pre-wrap",
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
                margin: 0,
              }}
            >
              {subtask.description ||
                (canEditDescription
                  ? "Click to add instructions, suggested flow, or acceptance cues…"
                  : "No description provided.")}
            </p>
          )}
        </section>

        <section>
          <h3 style={sectionLabel}>Due date</h3>
          {canEditDescription ? (
            <DueDateEditor
              value={subtask.dueDate}
              onChange={(date) => onDueChange(date ? toDateInputValue(date) : "")}
              disabled={dueBusy}
              isOverdue={isOverdue}
            />
          ) : subtask.dueDate ? (
            <p style={{ margin: 0, fontSize: "var(--text-md)", color: isOverdue ? "var(--color-danger, #dc2626)" : "var(--color-text)" }}>
              {subtask.dueDate.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
              {isOverdue && " — overdue"}
            </p>
          ) : (
            <p style={emptyHint}>No due date set.</p>
          )}
        </section>

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
                  ? "✗ rejected"
                  : questioned
                    ? "? question"
                    : approved
                      ? "✓ approved"
                      : "pending";
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
      </div>
    </Overlay>
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
 * Stage 2 polish — larger, more discoverable due-date editor. Native
 * `<input type="date">` calendar popup is browser-owned, but the input's
 * own footprint can be scaled up so it's visible at a glance and offers
 * quick-set shortcuts (Today / +1 week / +1 month) so you rarely need
 * the tiny native calendar at all.
 */
function DueDateEditor({
  value,
  onChange,
  disabled,
  isOverdue,
}: {
  value: Date | null;
  onChange: (date: Date | null) => void;
  disabled: boolean;
  isOverdue: boolean;
}) {
  function addDays(days: number): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d;
  }
  const displayLabel = value
    ? value.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "No due date";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: "24px",
            lineHeight: 1,
          }}
          aria-hidden="true"
        >
          📅
        </span>
        <input
          type="date"
          value={value ? toDateInputValue(value) : ""}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value) : null)}
          disabled={disabled}
          style={{
            padding: "0.6rem 0.85rem",
            background: "var(--color-bg-elevated)",
            border: `1px solid ${isOverdue ? "var(--color-danger, #dc2626)" : "var(--color-border)"}`,
            borderRadius: "var(--radius-md)",
            color: isOverdue ? "var(--color-danger, #dc2626)" : "var(--color-text)",
            fontSize: "var(--text-md)",
            fontFamily: "inherit",
            minWidth: "12rem",
            fontWeight: 500,
          }}
        />
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: isOverdue ? "var(--color-danger, #dc2626)" : "var(--color-text-muted)",
            fontWeight: 500,
          }}
        >
          {displayLabel}
          {isOverdue && " — overdue"}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <DueDateShortcut label="Today" disabled={disabled} onClick={() => onChange(addDays(0))} />
        <DueDateShortcut label="+1 week" disabled={disabled} onClick={() => onChange(addDays(7))} />
        <DueDateShortcut label="+2 weeks" disabled={disabled} onClick={() => onChange(addDays(14))} />
        <DueDateShortcut label="+1 month" disabled={disabled} onClick={() => onChange(addDays(30))} />
        {value && (
          <DueDateShortcut
            label="Clear"
            disabled={disabled}
            onClick={() => onChange(null)}
            variant="danger"
          />
        )}
      </div>
    </div>
  );
}

function DueDateShortcut({
  label,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  variant?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "0.4rem 0.75rem",
        background: "transparent",
        border: "1px solid var(--color-border)",
        borderRadius: "999px",
        color:
          variant === "danger"
            ? "var(--color-danger, #dc2626)"
            : "var(--color-text)",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {label}
    </button>
  );
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
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        zIndex: 50,
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
          maxWidth: "40rem",
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
            width: "2rem",
            height: "2rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "999px",
            color: "var(--color-text)",
            fontSize: "var(--text-md)",
            lineHeight: 1,
            cursor: "pointer",
            zIndex: 2,
            boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.15))",
          }}
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}
