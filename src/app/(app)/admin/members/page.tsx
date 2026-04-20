"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import { useAuth } from "@/auth/AuthProvider";
import MemberRow from "@/features/admin/MemberRow";
import { useMembers } from "@/features/admin/useMembers";

export default function MembersAdminPage() {
  const { user: currentUser } = useAuth();
  const [showRejected, setShowRejected] = useState(false);
  const { users, loading, error } = useMembers({ includeRejected: showRejected });

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
          {loading ? "Loading members…" : `${users.length} member${users.length === 1 ? "" : "s"}`}
        </p>
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
            checked={showRejected}
            onChange={(e) => setShowRejected(e.target.checked)}
          />
          <span>Show rejected</span>
        </label>
      </div>

      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)" }}>Couldn&apos;t load: {error.message}</p>
        </Card>
      )}

      {!loading && users.length === 0 && !error && (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>
            No members yet. Approve people from the Approvals tab first.
          </p>
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {currentUser &&
          users.map((u) => <MemberRow key={u.uid} user={u} currentAdminUid={currentUser.uid} />)}
      </div>
    </div>
  );
}
