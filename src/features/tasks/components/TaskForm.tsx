"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input, Textarea } from "@/components/ui/Input";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import {
  TASK_FIELD_LIMITS,
  TASK_KINDS,
  TASK_KIND_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskKind,
  type TaskPriority,
  type TaskSource,
  type TaskVisibility,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import type { TaskTemplate } from "@/lib/firestore/taskTemplates";
import { createTask, type CreateSubtaskInput } from "../taskMutations";
import { materialiseTemplate } from "../templateMutations";
import AssigneePicker from "./AssigneePicker";
import TemplatePicker from "./TemplatePicker";

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
  const [completerUids, setCompleterUids] = useState<string[]>(
    isCommittee ? [] : [currentUserUid],
  );
  const [reviewerUids, setReviewerUids] = useState<string[]>([]);
  const [kind, setKind] = useState<TaskKind>("generic");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueDate, setDueDate] = useState<string>("");
  const [visibility, setVisibility] = useState<TaskVisibility>(
    isCommittee ? "committee" : "assignees-only",
  );
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateSubtasks, setTemplateSubtasks] = useState<CreateSubtaskInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source: TaskSource = isCommittee ? "committee" : "personal";

  function handleTemplate(id: string | null, template: TaskTemplate | null) {
    setTemplateId(id);
    if (!template) {
      setTemplateSubtasks([]);
      return;
    }
    setTemplateSubtasks(materialiseTemplate(template));
    if (template.kind) setKind(template.kind);
  }

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
        completerUids,
        reviewerUids,
        priority,
        dueDate: dueDate ? new Date(dueDate) : null,
        visibility,
        subtasks: templateSubtasks.length > 0 ? templateSubtasks : undefined,
        sourceTemplateId: templateId,
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
        {isCommittee && (
          <TemplatePicker value={templateId} onChange={handleTemplate} disabled={busy} />
        )}

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
              <ResponsiveSelect
                value={projectId}
                onChange={setProjectId}
                options={
                  [
                    { value: "", label: "— none —" },
                    ...projects
                      .filter((p) => !p.archived)
                      .map((p) => ({ value: p.id, label: p.name })),
                  ] satisfies ResponsiveSelectOption[]
                }
                ariaLabel="Project"
              />
            </Field>

            <Field id="task-kind" label="Kind">
              <ResponsiveSelect<TaskKind>
                value={kind}
                onChange={setKind}
                options={TASK_KINDS.map<ResponsiveSelectOption<TaskKind>>((k) => ({
                  value: k,
                  label: TASK_KIND_LABELS[k],
                }))}
                ariaLabel="Kind"
              />
            </Field>
          </div>
        )}

        <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "1fr 1fr" }}>
          <Field id="task-priority" label="Priority">
            <ResponsiveSelect<TaskPriority>
              value={priority}
              onChange={setPriority}
              options={TASK_PRIORITIES.map<ResponsiveSelectOption<TaskPriority>>((p) => ({
                value: p,
                label: TASK_PRIORITY_LABELS[p],
              }))}
              ariaLabel="Priority"
            />
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

        {templateSubtasks.length > 0 && (
          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              background: "var(--color-accent-soft)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
            }}
          >
            <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
              Template will seed {templateSubtasks.length} subtasks (editable after creation):
            </span>
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
              {templateSubtasks.map((s, i) => (
                <li key={i}>
                  {s.title}
                  {(s.blockedBy?.length ?? 0) > 0 && (
                    <span style={{ color: "var(--color-text-subtle)", marginLeft: 6 }}>
                      — blocked by {s.blockedBy!.length}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {isCommittee && (
          <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "1fr 1fr" }}>
            <Field id="task-completers" label="Completers">
              <AssigneePicker
                users={users}
                selected={completerUids}
                onChange={setCompleterUids}
                max={TASK_FIELD_LIMITS.maxCompleters}
                role="completer"
              />
            </Field>

            <Field
              id="task-reviewers"
              label="Reviewers"
              hint="Final review gate. Leave empty if none."
            >
              <AssigneePicker
                users={users}
                selected={reviewerUids}
                onChange={setReviewerUids}
                max={TASK_FIELD_LIMITS.maxReviewers}
                role="reviewer"
              />
            </Field>
          </div>
        )}

        {isCommittee && isAdmin && (
          <Field id="task-visibility" label="Visibility">
            <ResponsiveSelect<TaskVisibility>
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "committee", label: "Committee-visible (default)" },
                {
                  value: "assignees-only",
                  label: "Private — completers + reviewers + admins only",
                },
              ]}
              ariaLabel="Visibility"
            />
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
