"use client";

import { useMemo, useState } from "react";
import Card from "@/components/ui/Card";
import { useAuth } from "@/auth/AuthProvider";
import MemberItem from "@/features/admin/MemberItem";
import MembersToolbar, {
  type NewsletterFilter,
  type RoleFilter,
  type StatusFilter,
  type TrackFilter,
} from "@/features/admin/MembersToolbar";
import { useMembers } from "@/features/admin/useMembers";
import {
  canApproveNewsletter,
  canDraftNewsletter,
  type UserDoc,
} from "@/lib/firestore/users";

function matchesQuery(u: UserDoc, needle: string): boolean {
  if (!needle) return true;
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const haystacks: Array<string | null | undefined> = [
    u.displayName,
    u.email,
    u.title,
    u.profile?.preferredName,
    u.profile?.universityEmail,
    u.profile?.subject,
  ];
  return haystacks.some((s) => s && s.toLowerCase().includes(q));
}

function matchesNewsletter(u: UserDoc, filter: NewsletterFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "draft":
      return canDraftNewsletter(u);
    case "approve":
      return canApproveNewsletter(u);
    case "none":
      return !canDraftNewsletter(u) && !canApproveNewsletter(u);
  }
}

function matchesTrack(u: UserDoc, filter: TrackFilter): boolean {
  const tracks = u.tracks ?? [];
  switch (filter) {
    case "all":
      return true;
    case "none":
      return tracks.length === 0;
    case "both":
      return tracks.includes("technical") && tracks.includes("governance");
    case "technical":
    case "governance":
      return tracks.includes(filter);
  }
}

export default function MembersAdminPage() {
  const { user: currentUser } = useAuth();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [trackFilter, setTrackFilter] = useState<TrackFilter>("all");
  const [newsletterFilter, setNewsletterFilter] = useState<NewsletterFilter>("all");
  const [expandedUid, setExpandedUid] = useState<string | null>(null);

  const { users, loading, error } = useMembers({
    includeRejected: roleFilter === "rejected",
  });

  const filtered = useMemo(() => {
    return users.filter((u) => {
      if (roleFilter === "rejected") {
        if (u.role !== "rejected") return false;
      } else if (roleFilter === "all") {
        if (u.role === "rejected") return false;
      } else {
        if (u.role !== roleFilter) return false;
      }
      if (statusFilter !== "all" && u.profile?.status !== statusFilter) return false;
      if (!matchesTrack(u, trackFilter)) return false;
      if (!matchesNewsletter(u, newsletterFilter)) return false;
      return matchesQuery(u, query);
    });
  }, [users, roleFilter, statusFilter, trackFilter, newsletterFilter, query]);

  const emptyMessage = query
    ? "No members match that search."
    : roleFilter === "rejected"
      ? "No rejected users."
      : "No members in this view yet.";

  return (
    <div>
      <MembersToolbar
        query={query}
        onQueryChange={setQuery}
        roleFilter={roleFilter}
        onRoleFilterChange={(next) => {
          setRoleFilter(next);
          setExpandedUid(null);
        }}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        trackFilter={trackFilter}
        onTrackFilterChange={setTrackFilter}
        newsletterFilter={newsletterFilter}
        onNewsletterFilterChange={setNewsletterFilter}
        count={filtered.length}
      />

      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)" }}>Couldn&apos;t load: {error.message}</p>
        </Card>
      )}

      {loading && (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>Loading members…</p>
        </Card>
      )}

      {!loading && filtered.length === 0 && !error && (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>{emptyMessage}</p>
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {currentUser &&
          filtered.map((u) => (
            <MemberItem
              key={u.uid}
              user={u}
              currentAdminUid={currentUser.uid}
              expanded={expandedUid === u.uid}
              onToggleExpand={() =>
                setExpandedUid((prev) => (prev === u.uid ? null : u.uid))
              }
            />
          ))}
      </div>
    </div>
  );
}
