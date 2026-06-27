"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import RegistrationFlags from "@/features/admin/RegistrationFlags";
import RegistrationRow from "@/features/admin/RegistrationRow";
import {
  useRegistrations,
  type RegistrationFilter,
} from "@/features/admin/useRegistrations";
import { useRegistrationSummary } from "@/features/admin/useRegistrationSummary";
import styles from "@/features/admin/Registrations.module.css";

const FILTERS: { value: RegistrationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orphans", label: "Orphans" },
  { value: "pending-verify", label: "Pending verify" },
  { value: "verified-no-password", label: "Verified · no password" },
  { value: "completed", label: "Completed" },
];

export default function AdminRegistrationsPage() {
  const [filter, setFilter] = useState<RegistrationFilter>("all");
  const summary = useRegistrationSummary();
  const list = useRegistrations(filter);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleDelete(uid: string) {
    setActionError(null);
    setDeletingUid(uid);
    try {
      const res = await fetch(`/api/admin/registrations/${encodeURIComponent(uid)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 207) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't delete that account.");
      }
      list.reload();
      void summary.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't delete that account.");
    } finally {
      setDeletingUid(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>Registrations</h1>
          <p className={styles.pageLede}>
            Signups created through the email-only register flow. Accounts that
            never set a password are benign orphans — they can&apos;t be signed
            into and are safe to clean up later. The panel below flags suspicious
            signup activity (bursts, high reCAPTCHA-fail rate, orphan backlog).
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void summary.reload();
            list.reload();
          }}
        >
          Refresh
        </Button>
      </div>

      {summary.error ? (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{summary.error}</p>
        </Card>
      ) : summary.summary ? (
        <RegistrationFlags summary={summary.summary} />
      ) : (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>Loading summary…</p>
        </Card>
      )}

      {actionError && (
        <Card padding="sm">
          <p style={{ color: "var(--color-danger)", margin: 0, fontSize: "var(--text-sm)" }}>
            {actionError}
          </p>
        </Card>
      )}

      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`${styles.filterChip} ${
              filter === f.value ? styles.filterChipActive : ""
            }`}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.error ? (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{list.error}</p>
        </Card>
      ) : list.loading ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            Loading registrations…
          </p>
        </Card>
      ) : list.rows.length === 0 ? (
        <Card padding="lg">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            No registrations{filter === "all" ? " yet" : " match this filter"}.
          </p>
        </Card>
      ) : (
        <>
          <div className={styles.list}>
            {list.rows.map((r) => (
              <RegistrationRow
                key={r.uid}
                reg={r}
                busy={deletingUid === r.uid}
                onDelete={() => handleDelete(r.uid)}
              />
            ))}
          </div>
          {list.hasMore && (
            <div className={styles.loadMore}>
              <Button
                variant="secondary"
                size="sm"
                onClick={list.loadMore}
                disabled={list.loadingMore}
              >
                {list.loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
