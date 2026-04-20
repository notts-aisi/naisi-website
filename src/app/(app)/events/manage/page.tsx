"use client";

import Link from "next/link";
import { useMemo } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { useAuth } from "@/auth/AuthProvider";
import { useEvents } from "@/features/events/useEvents";
import {
  EVENT_STATUS_LABEL,
  type EventDoc,
  type EventStatus,
} from "@/lib/firestore/events";
import {
  canApproveEvent,
  canDraftEvent,
} from "@/lib/firestore/users";
import styles from "./events.module.css";

function statusTone(status: EventStatus): "neutral" | "accent" | "success" | "danger" | "warning" {
  switch (status) {
    case "draft":
      return "neutral";
    case "pending":
      return "warning";
    case "approved":
      return "accent";
    case "published":
      return "success";
    case "rejected":
      return "danger";
    case "cancelled":
      return "danger";
  }
}

function formatWhen(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EventsListPage() {
  const { user, role, permissions } = useAuth();
  const { events, loading, error } = useEvents();

  const viewer =
    role && (role === "admin" || role === "committee" || role === "member")
      ? { role, permissions }
      : null;
  const canDraft = viewer ? canDraftEvent(viewer) : false;
  const canApprove = viewer ? canApproveEvent(viewer) : false;

  const pending = useMemo(
    () => events.filter((e) => e.status === "pending"),
    [events],
  );
  const mine = useMemo(
    () =>
      events.filter(
        (e) =>
          e.authorUid === user?.uid &&
          e.status !== "published" &&
          e.status !== "cancelled",
      ),
    [events, user],
  );
  const othersActive = useMemo(
    () =>
      events.filter(
        (e) =>
          e.authorUid !== user?.uid &&
          e.status !== "published" &&
          e.status !== "cancelled",
      ),
    [events, user],
  );
  const published = useMemo(
    () => events.filter((e) => e.status === "published"),
    [events],
  );
  const cancelled = useMemo(
    () => events.filter((e) => e.status === "cancelled"),
    [events],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div className={styles.header}>
        <div>
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            {canApprove
              ? "You can draft, review, and publish events."
              : canDraft
                ? "You can draft events and submit them for admin review."
                : "Read-only view of published events."}
          </p>
        </div>
        {canDraft && (
          <Link href="/events/manage/new">
            <Button>New event</Button>
          </Link>
        )}
      </div>

      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)" }}>Couldn&apos;t load events: {error.message}</p>
        </Card>
      )}

      {loading ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>Loading events…</p>
        </Card>
      ) : (
        <>
          {canApprove && pending.length > 0 && (
            <Section title={`Pending your review (${pending.length})`} tone="warning">
              <EventList rows={pending} currentUid={user?.uid ?? null} />
            </Section>
          )}

          <Section title="Your drafts">
            {mine.length === 0 ? (
              <EmptyCard
                message={
                  canDraft
                    ? "You haven't started any events yet."
                    : "You don't have permission to draft events."
                }
              />
            ) : (
              <EventList rows={mine} currentUid={user?.uid ?? null} />
            )}
          </Section>

          {othersActive.length > 0 && (
            <Section title={canApprove ? "Other drafts in progress" : "Committee drafts in progress"}>
              <EventList rows={othersActive} currentUid={user?.uid ?? null} />
            </Section>
          )}

          {published.length > 0 && (
            <Section title="Published">
              <EventList rows={published.slice(0, 20)} currentUid={user?.uid ?? null} />
            </Section>
          )}

          {cancelled.length > 0 && (
            <Section title="Cancelled">
              <EventList rows={cancelled.slice(0, 10)} currentUid={user?.uid ?? null} />
            </Section>
          )}
        </>
      )}
    </div>
  );

  function EventList({
    rows,
    currentUid,
  }: {
    rows: EventDoc[];
    currentUid: string | null;
  }) {
    return (
      <div className={styles.list}>
        {rows.map((e) => (
          <div key={e.id} className={styles.row}>
            <Link href={`/events/manage/${e.id}`} className={styles.rowLink}>
              <div className={styles.rowMain}>
                <div className={styles.title}>
                  {e.title || <span className={styles.muted}>(no title)</span>}
                </div>
                <div className={styles.meta}>
                  <Badge tone={statusTone(e.status)}>{EVENT_STATUS_LABEL[e.status]}</Badge>
                  <span className={styles.author}>
                    {e.authorUid === currentUid ? "You" : e.authorDisplayName ?? "Someone"}
                  </span>
                  {e.startAt && (
                    <span className={styles.muted}>· {formatWhen(e.startAt)}</span>
                  )}
                  {e.capacity !== null && (
                    <span className={styles.muted}>· cap {e.capacity}</span>
                  )}
                  <span className={styles.muted}>· {e.visibility === "public" ? "public" : "members"}</span>
                </div>
                {e.status === "rejected" && e.reviewerNotes && (
                  <p className={styles.rejectNote}>Reviewer note: {e.reviewerNotes}</p>
                )}
              </div>
            </Link>
          </div>
        ))}
      </div>
    );
  }
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "warning";
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className={`${styles.sectionTitle} ${tone === "warning" ? styles.sectionWarn : ""}`}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <Card padding="md">
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>{message}</p>
    </Card>
  );
}
