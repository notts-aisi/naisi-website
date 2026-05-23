"use client";

import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import { useTaskTemplates } from "../hooks/useTaskTemplates";
import type { TaskTemplate } from "@/lib/firestore/taskTemplates";

type Props = {
  value: string | null;
  onChange: (templateId: string | null, template: TaskTemplate | null) => void;
  disabled?: boolean;
};

export default function TemplatePicker({ value, onChange, disabled }: Props) {
  const { templates, loading } = useTaskTemplates();

  const options: ResponsiveSelectOption[] = [
    { value: "", label: "Blank task" },
    ...templates.map((t) => ({
      value: t.id,
      label: `${t.name}${t.subtasks.length ? ` — ${t.subtasks.length} steps` : ""}`,
    })),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
        Start from template
      </span>
      <ResponsiveSelect
        value={value ?? ""}
        onChange={(next) => {
          const id = next || null;
          const tpl = id ? templates.find((t) => t.id === id) ?? null : null;
          onChange(id, tpl);
        }}
        options={options}
        disabled={disabled || loading}
        ariaLabel="Task template"
      />
    </div>
  );
}
