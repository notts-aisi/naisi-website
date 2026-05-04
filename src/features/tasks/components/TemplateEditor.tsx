"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import {
  TASK_KINDS,
  TASK_KIND_LABELS,
  type TaskKind,
} from "@/lib/firestore/tasks";
import {
  TASK_TEMPLATE_FIELD_LIMITS,
  newTemplateSubtaskId,
  type TaskTemplate,
  type TemplateSubtask,
} from "@/lib/firestore/taskTemplates";
import {
  createTemplate,
  deleteTemplate,
  updateTemplate,
} from "../templateMutations";

type Props = {
  template: TaskTemplate | null;
  onDone: () => void;
  onDelete?: () => void;
};

type Draft = {
  name: string;
  description: string;
  kind: TaskKind | null;
  subtasks: TemplateSubtask[];
};

function draftFromTemplate(template: TaskTemplate | null): Draft {
  if (!template) {
    return { name: "", description: "", kind: null, subtasks: [] };
  }
  return {
    name: template.name,
    description: template.description,
    kind: template.kind,
    subtasks: template.subtasks.map((s) => ({ ...s, blockedBy: [...s.blockedBy] })),
  };
}

export default function TemplateEditor({ template, onDone, onDelete }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFromTemplate(template));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addSubtask() {
    setDraft((d) => ({
      ...d,
      subtasks: [
        ...d.subtasks,
        {
          // New row starts with an empty title — the id is just a
          // placeholder slug; once the user types a real title, the title
          // itself becomes the display handle and the id stays stable.
          id: newTemplateSubtaskId("subtask"),
          title: "",
          blockedBy: [],
        },
      ],
    }));
  }

  function updateSubtask(id: string, patch: Partial<TemplateSubtask>) {
    setDraft((d) => ({
      ...d,
      subtasks: d.subtasks.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }

  function removeSubtask(id: string) {
    setDraft((d) => ({
      ...d,
      subtasks: d.subtasks
        .filter((s) => s.id !== id)
        .map((s) => ({ ...s, blockedBy: s.blockedBy.filter((bid) => bid !== id) })),
    }));
  }

  function toggleBlockedBy(rowId: string, blockerId: string) {
    setDraft((d) => ({
      ...d,
      subtasks: d.subtasks.map((s) => {
        if (s.id !== rowId) return s;
        const next = s.blockedBy.includes(blockerId)
          ? s.blockedBy.filter((id) => id !== blockerId)
          : [...s.blockedBy, blockerId];
        return { ...s, blockedBy: next };
      }),
    }));
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      setError("Name required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (template) {
        await updateTemplate(template.id, {
          name: draft.name,
          description: draft.description,
          kind: draft.kind,
          subtasks: draft.subtasks.filter((s) => s.title.trim() !== ""),
        });
      } else {
        await createTemplate({
          name: draft.name,
          description: draft.description,
          kind: draft.kind,
          subtasks: draft.subtasks.filter((s) => s.title.trim() !== ""),
        });
      }
      onDone();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!template) return;
    if (!confirm(`Delete template "${template.name}"? Existing tasks are unaffected.`)) return;
    setBusy(true);
    try {
      await deleteTemplate(template.id);
      onDelete?.();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to delete");
      setBusy(false);
    }
  }

  return (
    <Card padding="lg">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Field id="tpl-name" label="Name">
          <Input
            id="tpl-name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            maxLength={TASK_TEMPLATE_FIELD_LIMITS.name}
            placeholder="e.g. Instagram post"
          />
        </Field>

        <Field id="tpl-desc" label="Description" hint="Short one-liner shown in the picker.">
          <Textarea
            id="tpl-desc"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            maxLength={TASK_TEMPLATE_FIELD_LIMITS.description}
            rows={2}
          />
        </Field>

        <Field id="tpl-kind" label="Categorisation (optional)">
          <Select
            id="tpl-kind"
            value={draft.kind ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, kind: (e.target.value || null) as TaskKind | null }))
            }
          >
            <option value="">Any / uncategorised</option>
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {TASK_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--space-2)",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "var(--text-md)" }}>Subtasks</h3>
            <Button type="button" variant="secondary" onClick={addSubtask} disabled={busy}>
              Add step
            </Button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {draft.subtasks.length === 0 && (
              <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                No steps yet. A template with zero steps is valid but not very useful.
              </p>
            )}
            {draft.subtasks.map((s, idx) => {
              const others = draft.subtasks.filter((o) => o.id !== s.id);
              return (
                <div
                  key={s.id}
                  style={{
                    padding: "var(--space-3)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--color-bg-elevated)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--color-text-subtle)",
                        width: "1.75rem",
                      }}
                    >
                      {idx + 1}.
                    </span>
                    <Input
                      value={s.title}
                      onChange={(e) => updateSubtask(s.id, { title: e.target.value })}
                      placeholder="Step title"
                      maxLength={TASK_TEMPLATE_FIELD_LIMITS.subtaskTitle}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => removeSubtask(s.id)}
                      aria-label="Remove step"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--color-text-subtle)",
                        cursor: "pointer",
                        fontSize: "var(--text-sm)",
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  {others.length > 0 && (
                    <div>
                      <div
                        style={{
                          fontSize: "var(--text-xs)",
                          color: "var(--color-text-muted)",
                          marginBottom: "var(--space-1)",
                        }}
                      >
                        Blocked by (must be done first):
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                        {others.map((o) => (
                          <label
                            key={o.id}
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
                              checked={s.blockedBy.includes(o.id)}
                              onChange={() => toggleBlockedBy(s.id, o.id)}
                            />
                            <span style={{ color: "var(--color-text-muted)" }}>
                              {o.title || "(untitled)"}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {error && <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{error}</p>}

        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          {template && onDelete && (
            <Button type="button" variant="danger" onClick={handleDelete} disabled={busy}>
              Delete
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={busy}>
            {busy ? "Saving…" : template ? "Save changes" : "Create template"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
