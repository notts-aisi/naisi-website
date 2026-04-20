"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
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
  const [leadUid, setLeadUid] = useState(existing?.leadUid ?? committee[0]?.uid ?? "");
  const [memberUids, setMemberUids] = useState<string[]>(existing?.memberUids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leadOptions = useMemo(
    () => committee.filter((m) => m.role === "committee" || m.role === "admin"),
    [committee],
  );

  function toggleMember(uid: string) {
    setMemberUids((prev) =>
      prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid],
    );
  }

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

        <Field id="project-lead" label="Lead">
          <select
            id="project-lead"
            value={leadUid}
            onChange={(e) => setLeadUid(e.target.value)}
            style={{
              padding: "0.65rem 0.85rem",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: "var(--text-base)",
            }}
          >
            {leadOptions.length === 0 && <option value="">No committee members yet</option>}
            {leadOptions.map((m) => (
              <option key={m.uid} value={m.uid}>
                {m.displayName ?? m.email ?? m.uid}
              </option>
            ))}
          </select>
        </Field>

        <Field id="project-members" label="Members (tick to include)">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              background: "var(--color-bg-elevated)",
              maxHeight: "14rem",
              overflowY: "auto",
            }}
          >
            {committee.length === 0 && (
              <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                No members yet. Approve signups first.
              </p>
            )}
            {committee.map((m) => (
              <label
                key={m.uid}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}
              >
                <input
                  type="checkbox"
                  checked={memberUids.includes(m.uid)}
                  onChange={() => toggleMember(m.uid)}
                />
                <span>{m.displayName ?? m.email}</span>
              </label>
            ))}
          </div>
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
