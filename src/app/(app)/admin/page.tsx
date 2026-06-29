"use client";

import { useMemo } from "react";
import Card from "@/components/ui/Card";
import {
  AdminPage,
  AdminLoadingBar,
  AdminListFooter,
  useClientPagination,
} from "@/features/admin/adminList";
import ApprovalCard from "@/features/admin/ApprovalCard";
import { useApprovals } from "@/features/admin/useApprovals";
import { useUniEmailIndex } from "@/features/admin/useUniEmailIndex";

export default function ApprovalsPage() {
  const { users, loading, refreshing, error, reload } = useApprovals();
  // Only check the uni emails actually on screen — the hook queries just these,
  // instead of scanning the whole users collection.
  const uniEmails = useMemo(
    () => users.map((u) => u.profile?.universityEmail ?? "").filter(Boolean),
    [users],
  );
  const uniEmailIndex = useUniEmailIndex(uniEmails);

  const { shown, hasMore, loadMore, total, shownCount } = useClientPagination(users, 20);

  return (
    <AdminPage>
      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)" }}>
            Couldn&apos;t load applications: {error.message}
          </p>
        </Card>
      )}

      {loading && (
        <Card padding="md">
          <AdminLoadingBar label="Loading applications…" />
        </Card>
      )}

      {!loading && !error && users.length === 0 && (
        <Card padding="lg">
          <h2 style={{ fontSize: "var(--text-xl)", marginBottom: "var(--space-2)" }}>
            No pending applications
          </h2>
          <p style={{ color: "var(--color-text-muted)" }}>
            When someone signs up at <code>/register</code>, they&apos;ll show up here for you or
            Lloyd to review.
          </p>
        </Card>
      )}

      {!loading && !error && users.length > 0 && (
        <p style={{ color: "var(--color-text-muted)" }}>
          {users.length} application{users.length === 1 ? "" : "s"} waiting for review.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {shown.map((u) => {
          const uniEmail = u.profile?.universityEmail?.trim().toLowerCase();
          const conflicts = uniEmail
            ? (uniEmailIndex.get(uniEmail) ?? []).filter((h) => h.uid !== u.uid)
            : [];
          return (
            <ApprovalCard key={u.uid} user={u} uniEmailConflicts={conflicts} />
          );
        })}
      </div>

      {!loading && !error && total > 0 && (
        <AdminListFooter
          shownCount={shownCount}
          total={total}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRefresh={reload}
          refreshing={refreshing}
          noun="applications"
        />
      )}
    </AdminPage>
  );
}
