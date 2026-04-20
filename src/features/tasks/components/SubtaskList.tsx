"use client";

import { useState } from "react";
import { TASK_FIELD_LIMITS, type TaskDoc } from "@/lib/firestore/tasks";
import { addSubtask, removeSubtask, toggleSubtask } from "../taskMutations";

type Props = {
  task: TaskDoc;
  canEdit: boolean;
};

export default function SubtaskList({ task, canEdit }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await addSubtask(task, trimmed);
      setDraft("");
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {task.subtasks.length === 0 && !canEdit && (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
          No subtasks.
        </p>
      )}
      {task.subtasks.map((s) => (
        <div
          key={s.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "0.5rem 0.75rem",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <input
            type="checkbox"
            checked={s.done}
            onChange={() => toggleSubtask(task, s.id).catch(console.error)}
            aria-label={`Mark "${s.title}" ${s.done ? "incomplete" : "complete"}`}
          />
          <span
            style={{
              flex: 1,
              fontSize: "var(--text-sm)",
              textDecoration: s.done ? "line-through" : "none",
              color: s.done ? "var(--color-text-muted)" : "var(--color-text)",
            }}
          >
            {s.title}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={() => removeSubtask(task, s.id).catch(console.error)}
              aria-label="Remove subtask"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-text-subtle)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}

      {canEdit && task.subtasks.length < TASK_FIELD_LIMITS.maxSubtasks && (
        <form onSubmit={handleAdd} style={{ display: "flex", gap: "var(--space-2)" }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add subtask…"
            maxLength={TASK_FIELD_LIMITS.subtaskTitle}
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              background: "var(--color-bg-elevated)",
              border: "1px dashed var(--color-border)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: "var(--text-sm)",
            }}
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            style={{
              padding: "0.5rem 0.85rem",
              background: "var(--color-accent-soft)",
              color: "var(--color-accent)",
              border: "none",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-sm)",
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </form>
      )}
    </div>
  );
}
