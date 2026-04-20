"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import {
  TASK_FIELD_LIMITS,
  TASK_KINDS,
  TASK_KIND_LABELS,
  TASK_KIND_SUBTASK_TEMPLATES,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskKind,
  type TaskPriority,
  type TaskSource,
  type TaskVisibility,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import { createTask } from "../taskMutations";
import AssigneePicker from "./AssigneePicker";

type Props = {
  mode: "committee" | "personal";
  isAdmin: boolean;
  projects: ProjectDoc[];
  users: UserDoc[];
  onDone: () => void;
  defaultProjectId?: string;
  currentUserUid: string;
};

export default function TaskForm({
  mode,
  isAdmin,
  projects,
  users,
  onDone,
  defaultProjectId,
  currentUserUid,
}: Props) {
  const isCommittee = mode === "committee";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const [assigneeUids, setAssigneeUids] = useState<string[]>(
    isCommittee ? [] : [currentUserUid],
  );
  const [kind, setKind] = useState<TaskKind>("generic");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueDate, setDueDate] = useState<string>("");
  const [visibility, setVisibility] = useState<TaskVisibility>(
    isCommittee ? "committee" : "assignees-only",
  );
  const [useTemplate, setUseTemplate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source: TaskSource = isCommittee ? "committee" : "personal";
  const template = TASK_KIND_SUBTASK_TEMPLATES[kind] ?? [];
  const hasTemplate = template.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("Title required.");
      return;
    }
    setBusy(true);
    try {
      await createTask({
        title: title.trim(),
        description,
        source,
        kind,
        projectId: isCommittee ? projectId || null : null,
        assigneeUids,
        priority,
        dueDate: dueDate ? new Date(dueDate) : null,
        visibility,
        subtasks: useTemplate && hasTemplate ? template.map((t) => ({ title: t })) : undefined,
      });
      onDone();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to create task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg">
      <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>
        {isCommittee ? "New committee task" : "New personal task"}
      </h3>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Field id="task-title" label="Title">
          <Input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TASK_FIELD_LIMITS.title}
            required
            placeholder="Short, specific action e.g. 'Draft Insta carousel on EU AI Act'"
          />
        </Field>

        <Field id="task-description" label="Description" hint="Optional">
          <Textarea
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={TASK_FIELD_LIMITS.description}
            placeholder="Context, links, acceptance criteria…"
          />
        </Field>

        {isCommittee && (
          <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "1fr 1fr" }}>
            <Field id="task-project" label="Project">
              <Select
                id="task-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">— none —</option>
                {projects
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>

            <Field id="task-kind" label="Kind">
              <Select
                id="task-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as TaskKind)}
              >
                {TASK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TASK_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "1fr 1fr" }}>
          <Field id="task-priority" label="Priority">
            <Select
              id="task-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="task-due"
            label={kind === "social" || kind === "event" ? "Date of event" : "Due date"}
            hint="Optional"
          >
            <Input
              id="task-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
        </div>

        {hasTemplate && (
          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              background: "var(--color-accent-soft)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={useTemplate}
                onChange={(e) => setUseTemplate(e.target.checked)}
              />
              <span>
                Auto-add {template.length} subtasks for {TASK_KIND_LABELS[kind].toLowerCase()}
              </span>
            </label>
            {useTemplate && (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "var(--space-6)",
                  fontSize: "var(--text-xs)",
                  color: "var(--color-text-muted)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.15rem",
                }}
              >
                {template.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {isCommittee && (
          <Field id="task-assignees" label="Assignees">
            <AssigneePicker
              users={users}
              selected={assigneeUids}
              onChange={setAssigneeUids}
              max={TASK_FIELD_LIMITS.maxAssignees}
            />
          </Field>
        )}

        {isCommittee && isAdmin && (
          <Field id="task-visibility" label="Visibility">
            <Select
              id="task-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as TaskVisibility)}
            >
              <option value="committee">Committee-visible (default)</option>
              <option value="assignees-only">Private — assignees + admins only</option>
            </Select>
          </Field>
        )}

        {error && <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{error}</p>}

        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create task"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
