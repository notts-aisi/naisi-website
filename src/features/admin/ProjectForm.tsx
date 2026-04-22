"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import AssigneePicker from "@/features/tasks/components/AssigneePicker";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import { createProject, updateProject } from "./adminMutations";

type Props = {
  existing?: ProjectDoc;
  committee: UserDoc[];
  onDone: () => void;
};

export default function ProjectForm({ existing, committee, onDone }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [leadUid, setLeadUid] = useState(existing?.leadUid ?? "");
  const [memberUids, setMemberUids] = useState<string[]>(existing?.memberUids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lead must be committee or admin (same gate as before). The previous build
  // also defaulted leadUid to committee[0].uid but that silently picked a lead
  // without the user realising — switching to explicit placeholder instead.
  const leadOptions = useMemo(
    () =>
      committee
        .filter((m) => m.role === "committee" || m.role === "admin")
        .sort((a, b) =>
          (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? ""),
        ),
    [committee],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Project needs a name.");
      return;
    }
    if (!leadUid) {
      setError("Pick a lead.");
      return;
    }
    setBusy(true);
    try {
      if (existing) {
        await updateProject(existing.id, { name: name.trim(), leadUid, memberUids });
      } else {
        await createProject({ name: name.trim(), leadUid, memberUids });
      }
      onDone();
    } catch (err) {
      console.error(err);
      setError("Failed to save — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg">
      <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>
        {existing ? "Edit project" : "New project"}
      </h3>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Field id="project-name" label="Name">
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Technical Alignment Reading Group"
            required
          />
        </Field>

        <Field id="project-lead" label="Lead" hint="Committee members + admins only.">
          <Select
            id="project-lead"
            value={leadUid}
            onChange={(e) => setLeadUid(e.target.value)}
            required
          >
            <option value="">— pick a lead —</option>
            {leadOptions.map((m) => (
              <option key={m.uid} value={m.uid}>
                {m.displayName ?? m.email ?? m.uid}
                {m.role === "admin" ? " (admin)" : ""}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="project-members"
          label="Members"
          hint="Filter by role or search by name. Any role can be a project member."
        >
          <AssigneePicker
            users={committee}
            selected={memberUids}
            onChange={setMemberUids}
            max={50}
            role="completer"
            showRoleFilter
          />
        </Field>

        {error && (
          <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : existing ? "Save changes" : "Create project"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
