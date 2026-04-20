"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import ProjectCard from "@/features/admin/ProjectCard";
import ProjectForm from "@/features/admin/ProjectForm";
import { useMembers } from "@/features/admin/useMembers";
import { useProjects } from "@/features/admin/useProjects";

export default function ProjectsAdminPage() {
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { projects, loading } = useProjects();
  const { users: members } = useMembers();

  const visible = projects.filter((p) => (showArchived ? true : !p.archived));

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--space-5)",
          flexWrap: "wrap",
          gap: "var(--space-3)",
        }}
      >
        <p style={{ color: "var(--color-text-muted)" }}>
          {loading
            ? "Loading projects…"
            : `${visible.length} project${visible.length === 1 ? "" : "s"}${
                showArchived ? "" : " (active)"
              }`}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "var(--text-sm)",
              color: "var(--color-text-muted)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span>Show archived</span>
          </label>
          <Button onClick={() => setCreating(true)} size="sm">
            New project
          </Button>
        </div>
      </div>

      {creating && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <ProjectForm committee={members} onDone={() => setCreating(false)} />
        </div>
      )}

      {!loading && visible.length === 0 && !creating && (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>
            No projects yet. Click <strong>New project</strong> to create the first one.
          </p>
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {visible.map((p) => (
          <ProjectCard key={p.id} project={p} committee={members} />
        ))}
      </div>
    </div>
  );
}
