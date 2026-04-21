"use client";

import { useState } from "react";
import { TASK_FIELD_LIMITS, type TaskDoc } from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import { addSubtask } from "../taskMutations";
import SubtaskRow from "./SubtaskRow";

type Props = {
  task: TaskDoc;
  users: UserDoc[];
  canEdit: boolean;
};

export default function SubtaskList({ task, users, canEdit }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await addSubtask(task, { title: trimmed });
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
        <SubtaskRow key={s.id} task={task} subtask={s} users={users} canEdit={canEdit} />
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
