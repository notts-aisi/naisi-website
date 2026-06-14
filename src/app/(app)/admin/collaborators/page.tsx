"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import CollaboratorCard from "@/features/admin/CollaboratorCard";
import { useCollaborators } from "@/features/admin/useCollaborators";
import { useCollaboratorVerification } from "@/features/admin/useCollaboratorVerification";
import type { CollaboratorDoc } from "@/lib/firestore/collaborators";

export default function AdminCollaboratorsPage() {
  const { collaborators, loading, error } = useCollaborators();
  const verified = useCollaboratorVerification(collaborators.map((c) => c.uid));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(id: string, run: () => Promise<Response>) {
    setActionError(null);
    setBusyId(id);
    try {
      const res = await run();
      if (!res.ok && res.status !== 207) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "That action failed.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "That action failed.");
    } finally {
      setBusyId(null);
    }
  }

  const approve = (c: CollaboratorDoc) =>
    act(c.id, () =>
      fetch(`/api/collaborators/${encodeURIComponent(c.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
    );

  const reject = (c: CollaboratorDoc, reason: string) =>
    act(c.id, () =>
      fetch(`/api/collaborators/${encodeURIComponent(c.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", reason }),
      }),
    );

  const remove = (c: CollaboratorDoc) =>
    act(c.id, () =>
      fetch(`/api/collaborators/${encodeURIComponent(c.id)}`, { method: "DELETE" }),
    );

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading collaborators…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t load collaborators: {error.message}
        </p>
      </Card>
    );
  }

  const pending = collaborators.filter((c) => c.status === "pending");
  const decided = collaborators.filter((c) => c.status !== "pending");

  if (collaborators.length === 0) {
    return (
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", marginBottom: "var(--space-2)" }}>
          No collaborator applications yet
        </h2>
        <p style={{ color: "var(--color-text-muted)" }}>
          External researchers who apply via the &ldquo;Collaborate with us&rdquo; option will
          show up here for review.
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      {actionError && (
        <Card padding="sm">
          <p style={{ color: "var(--color-danger)", margin: 0, fontSize: "var(--text-sm)" }}>
            {actionError}
          </p>
        </Card>
      )}

      <section>
        <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>
          Pending review ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            Nothing waiting for review.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {pending.map((c) => (
              <CollaboratorCard
                key={c.id}
                collaborator={c}
                emailVerified={verified[c.uid]}
                busy={busyId === c.id}
                onApprove={() => approve(c)}
                onReject={(reason) => reject(c, reason)}
                onDelete={() => remove(c)}
              />
            ))}
          </div>
        )}
      </section>

      {decided.length > 0 && (
        <section>
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>
            Decided ({decided.length})
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {decided.map((c) => (
              <CollaboratorCard
                key={c.id}
                collaborator={c}
                emailVerified={verified[c.uid]}
                busy={busyId === c.id}
                onApprove={() => approve(c)}
                onReject={(reason) => reject(c, reason)}
                onDelete={() => remove(c)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
