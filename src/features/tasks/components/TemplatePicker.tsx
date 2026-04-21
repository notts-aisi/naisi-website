"use client";

import { Select } from "@/components/ui/Input";
import { useTaskTemplates } from "../hooks/useTaskTemplates";
import type { TaskTemplate } from "@/lib/firestore/taskTemplates";

type Props = {
  value: string | null;
  onChange: (templateId: string | null, template: TaskTemplate | null) => void;
  disabled?: boolean;
};

export default function TemplatePicker({ value, onChange, disabled }: Props) {
  const { templates, loading } = useTaskTemplates();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
        Start from template
      </span>
      <Select
        value={value ?? ""}
        onChange={(e) => {
          const id = e.target.value || null;
          const tpl = id ? templates.find((t) => t.id === id) ?? null : null;
          onChange(id, tpl);
        }}
        disabled={disabled || loading}
        aria-label="Task template"
      >
        <option value="">Blank task</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.subtasks.length ? ` — ${t.subtasks.length} steps` : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}
