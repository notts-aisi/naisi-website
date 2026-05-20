"use client";

import Card from "@/components/ui/Card";
import ApprovalCard from "@/features/admin/ApprovalCard";
import { useApprovals } from "@/features/admin/useApprovals";
import { useUniEmailIndex } from "@/features/admin/useUniEmailIndex";

export default function ApprovalsPage() {
  const { users, loading, error } = useApprovals();
  const uniEmailIndex = useUniEmailIndex();

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading applications…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t load applications: {error.message}
        </p>
      </Card>
    );
  }

  if (users.length === 0) {
    return (
      <Card padding="lg">
        <h2 style={{ fontSize: "var(--text-xl)", marginBottom: "var(--space-2)" }}>
          No pending applications
        </h2>
        <p style={{ color: "var(--color-text-muted)" }}>
          When someone signs up at <code>/register</code>, they&apos;ll show up here for you or
          Lloyd to review.
        </p>
      </Card>
    );
  }

  return (
    <div>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-5)" }}>
        {users.length} application{users.length === 1 ? "" : "s"} waiting for review.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {users.map((u) => {
          const uniEmail = u.profile?.universityEmail?.trim().toLowerCase();
          const conflicts = uniEmail
            ? (uniEmailIndex.get(uniEmail) ?? []).filter((h) => h.uid !== u.uid)
            : [];
          return (
            <ApprovalCard key={u.uid} user={u} uniEmailConflicts={conflicts} />
          );
        })}
      </div>
    </div>
  );
}
