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
              <RegistrationRow key={r.uid} reg={r} />
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
