"use client";

import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import ProjectForm from "./ProjectForm";
import { deleteProject, setProjectArchived } from "./adminMutations";

type Props = {
  project: ProjectDoc;
  committee: UserDoc[];
};

export default function ProjectCard({ project, committee }: Props) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const lead = useMemo(
    () => committee.find((m) => m.uid === project.leadUid),
    [committee, project.leadUid],
  );
  const members = useMemo(
    () => committee.filter((m) => project.memberUids.includes(m.uid)),
    [committee, project.memberUids],
  );

  if (editing) {
    return <ProjectForm existing={project} committee={committee} onDone={() => setEditing(false)} />;
  }

  async function toggleArchive() {
    const verb = project.archived ? "Unarchive" : "Archive";
    if (!window.confirm(`${verb} "${project.name}"?`)) return;
    setBusy(true);
    try {
      await setProjectArchived(project.id, !project.archived);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Permanently delete "${project.name}"? This can't be undone. Any tasks linked to it will lose their project reference.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteProject(project.id);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
    // On success the snapshot listener removes the card from the list automatically.
  }

  return (
    <Card padding="md" style={{ opacity: project.archived ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <h3 style={{ fontSize: "var(--text-lg)" }}>{project.name}</h3>
            {project.archived && <Badge tone="neutral">Archived</Badge>}
          </div>
          <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginTop: "var(--space-1)" }}>
            Lead: {lead?.displayName ?? lead?.email ?? "—"} · {members.length} member{members.length === 1 ? "" : "s"}
          </div>
          {members.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-2)",
                marginTop: "var(--space-3)",
              }}
            >
              {members.map((m) => (
                <Badge key={m.uid} tone="neutral">
                  {m.displayName ?? m.email}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0, flexWrap: "wrap" }}>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleArchive} disabled={busy}>
            {project.archived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            disabled={busy}
            style={{ color: "var(--color-danger)" }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}
