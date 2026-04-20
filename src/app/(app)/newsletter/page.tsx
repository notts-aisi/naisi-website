"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { useAuth } from "@/auth/AuthProvider";
import { deleteDraft } from "@/features/newsletter/draftMutations";
import { useDrafts } from "@/features/newsletter/useDrafts";
import {
  DRAFT_STATUS_LABEL,
  type DraftStatus,
  type NewsletterDraft,
} from "@/lib/firestore/newsletterDrafts";
import {
  canApproveNewsletter,
  canDraftNewsletter,
} from "@/lib/firestore/users";
import styles from "./newsletter.module.css";

function statusTone(status: DraftStatus): "neutral" | "accent" | "success" | "danger" | "warning" {
  switch (status) {
    case "draft":
      return "neutral";
    case "pending":
      return "warning";
    case "approved":
      return "accent";
    case "sent":
      return "success";
    case "rejected":
      return "danger";
  }
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NewsletterListPage() {
  const { user, role, permissions } = useAuth();
  const { drafts, loading, error } = useDrafts();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const viewer = role && (role === "admin" || role === "committee" || role === "member")
    ? { role, permissions }
    : null;

  const canDraft = viewer ? canDraftNewsletter(viewer) : false;
  const canApprove = viewer ? canApproveNewsletter(viewer) : false;

  const pendingDrafts = useMemo(
    () => drafts.filter((d) => d.status === "pending"),
    [drafts],
  );
  const activeDrafts = useMemo(
    () => drafts.filter((d) => d.status !== "sent"),
    [drafts],
  );
  const sentDrafts = useMemo(
    () => drafts.filter((d) => d.status === "sent"),
    [drafts],
  );

  const mine = useMemo(
    () => activeDrafts.filter((d) => d.authorUid === user?.uid),
    [activeDrafts, user],
  );
  const othersActive = useMemo(
    () => activeDrafts.filter((d) => d.authorUid !== user?.uid),
    [activeDrafts, user],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div className={styles.header}>
        <div>
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            {canApprove
              ? "You can draft, review, and send newsletters."
              : canDraft
                ? "You can draft newsletters and submit them for admin review."
                : "Read-only view."}
          </p>
        </div>
        {canDraft && (
          <Link href="/newsletter/new">
            <Button>New draft</Button>
          </Link>
        )}
      </div>

      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)" }}>Couldn&apos;t load drafts: {error.message}</p>
        </Card>
      )}

      {deleteError && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>Delete failed: {deleteError}</p>
        </Card>
      )}

      {loading ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>Loading drafts…</p>
        </Card>
      ) : (
        <>
          {canApprove && pendingDrafts.length > 0 && (
            <Section title={`Pending your review (${pendingDrafts.length})`} tone="warning">
              <DraftList drafts={pendingDrafts} />
            </Section>
          )}

          <Section title="Your drafts">
            {mine.length === 0 ? (
              <EmptyCard message={canDraft ? "You haven't started any drafts yet." : "You don't have permission to draft newsletters."} />
            ) : (
              <DraftList drafts={mine} />
            )}
          </Section>

          {othersActive.length > 0 && (
            <Section title={canApprove ? "Other drafts in progress" : "Committee drafts in progress"}>
              <DraftList drafts={othersActive} />
            </Section>
          )}

          {sentDrafts.length > 0 && (
            <Section title="Recently sent">
              <DraftList drafts={sentDrafts.slice(0, 10)} />
            </Section>
          )}
        </>
      )}
    </div>
  );

  async function onDeleteSent(d: NewsletterDraft) {
    if (
      !window.confirm(
        `Permanently delete the sent edition "${d.subject || "(no subject)"}"? This removes the record from Firestore but cannot recall emails that were already sent.`,
      )
    ) {
      return;
    }
    setDeletingId(d.id);
    setDeleteError(null);
    try {
      await deleteDraft(d.id);
    } catch (err) {
      console.error(err);
      setDeleteError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeletingId(null);
    }
  }

  function DraftList({ drafts: rows }: { drafts: NewsletterDraft[] }) {
    return (
      <div className={styles.list}>
        {rows.map((d) => {
          const canDeleteSent =
            d.status === "sent" && (role === "admin" || d.authorUid === user?.uid);
          return (
            <div key={d.id} className={styles.row}>
              <Link href={`/newsletter/${d.id}`} className={styles.rowLink}>
                <div className={styles.rowMain}>
                  <div className={styles.subject}>
                    {d.subject || <span className={styles.muted}>(no subject)</span>}
                  </div>
                  <div className={styles.meta}>
                    <Badge tone={statusTone(d.status)}>{DRAFT_STATUS_LABEL[d.status]}</Badge>
                    <span className={styles.author}>
                      {d.authorUid === user?.uid ? "You" : d.authorDisplayName ?? "Someone"}
                    </span>
                    <span className={styles.muted}>· updated {formatDate(d.updatedAt)}</span>
                    {d.status === "sent" && d.sentCount != null && (
                      <span className={styles.muted}>
                        ·{" "}
                        {d.subscribersReached != null
                          ? `${d.subscribersReached} subscriber${d.subscribersReached === 1 ? "" : "s"} (${d.sentCount} email${d.sentCount === 1 ? "" : "s"})`
                          : `${d.sentCount} email${d.sentCount === 1 ? "" : "s"}`}
                      </span>
                    )}
                  </div>
                  {d.status === "rejected" && d.reviewerNotes && (
                    <p className={styles.rejectNote}>Reviewer note: {d.reviewerNotes}</p>
                  )}
                </div>
              </Link>
              {canDeleteSent && (
                <button
                  type="button"
                  onClick={() => void onDeleteSent(d)}
                  disabled={deletingId === d.id}
                  className={styles.rowDelete}
                  aria-label={`Delete sent edition: ${d.subject || "no subject"}`}
                >
                  {deletingId === d.id ? "Deleting…" : "Delete"}
                </button>
              )}
            </div>
          );
        })}
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
