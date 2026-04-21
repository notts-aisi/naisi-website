"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { useAuth } from "@/auth/AuthProvider";
import { useTaskTemplates } from "@/features/tasks/hooks/useTaskTemplates";
import TemplateEditor from "@/features/tasks/components/TemplateEditor";
import { TASK_KIND_LABELS } from "@/lib/firestore/tasks";
import type { TaskTemplate } from "@/lib/firestore/taskTemplates";

type Mode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; template: TaskTemplate };

export default function TaskTemplatesPage() {
  const { role } = useAuth();
  const { templates, loading } = useTaskTemplates();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  if (role && role !== "admin") {
    return (
      <Card padding="md">
        <p>Task templates are managed by admins only.</p>
      </Card>
    );
  }

  if (mode.kind !== "list") {
    return (
      <div>
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Badge tone="accent">Admin</Badge>
          <h1 style={{ marginTop: "var(--space-2)" }}>
            {mode.kind === "create" ? "New task template" : `Edit "${mode.template.name}"`}
          </h1>
        </div>
        <TemplateEditor
          template={mode.kind === "edit" ? mode.template : null}
          onDone={() => setMode({ kind: "list" })}
          onDelete={mode.kind === "edit" ? () => setMode({ kind: "list" }) : undefined}
        />
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "var(--space-3)",
          flexWrap: "wrap",
          marginBottom: "var(--space-5)",
        }}
      >
        <div>
          <Badge tone="accent">Admin</Badge>
          <h1 style={{ marginTop: "var(--space-2)" }}>Task templates</h1>
          <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-1)" }}>
            Reusable task structures — subtask checklists, role hints, and gating. Committee
            members pick from these when creating a task.
          </p>
        </div>
        <Button onClick={() => setMode({ kind: "create" })}>New template</Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--color-text-muted)" }}>Loading templates…</p>
      ) : templates.length === 0 ? (
        <Card padding="lg">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            No templates yet. Create one, or run <code>scripts/seed-task-templates.mjs</code> to
            seed the defaults (social, event, Instagram).
          </p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {templates.map((t) => (
            <Card
              key={t.id}
              padding="md"
              interactive
              onClick={() => setMode({ kind: "edit", template: t })}
              style={{ cursor: "pointer" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "var(--space-3)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--space-2)",
                      alignItems: "center",
                      marginBottom: "var(--space-1)",
                    }}
                  >
                    <strong>{t.name}</strong>
                    {t.kind && <Badge tone="neutral">{TASK_KIND_LABELS[t.kind]}</Badge>}
                  </div>
                  {t.description && (
                    <p
                      style={{
                        margin: 0,
                        fontSize: "var(--text-sm)",
                        color: "var(--color-text-muted)",
                      }}
                    >
                      {t.description}
                    </p>
                  )}
                </div>
                <span
                  style={{ fontSize: "var(--text-xs)", color: "var(--color-text-subtle)" }}
                >
                  {t.subtasks.length} step{t.subtasks.length === 1 ? "" : "s"}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
