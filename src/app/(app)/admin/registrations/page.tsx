"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import RegistrationFlags from "@/features/admin/RegistrationFlags";
import RegistrationRow from "@/features/admin/RegistrationRow";
import {
  useAllRegistrations,
  type RegistrationFilter,
} from "@/features/admin/useRegistrations";
import { useRegistrationSummary } from "@/features/admin/useRegistrationSummary";
import {
  ORPHAN_STATUSES,
  type RegistrationView,
} from "@/lib/firestore/registrations";
import styles from "@/features/admin/Registrations.module.css";

const FILTERS: { value: RegistrationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orphans", label: "Orphans" },
  { value: "pending-verify", label: "Pending verify" },
  { value: "verified-no-password", label: "Verified · no password" },
  { value: "pending-profile", label: "No profile (Google)" },
  { value: "completed", label: "Completed" },
];

function matchesFilter(reg: RegistrationView, filter: RegistrationFilter): boolean {
  if (filter === "all") return true;
  if (filter === "orphans") return ORPHAN_STATUSES.includes(reg.status);
  return reg.status === filter;
}

export default function AdminRegistrationsPage() {
  const [filter, setFilter] = useState<RegistrationFilter>("all");
  const summary = useRegistrationSummary();
  const list = useAllRegistrations();
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Client-side filtering off the cached rows — instant, no re-query per pill.
  const filtered = useMemo(
    () => list.rows.filter((r) => matchesFilter(r, filter)),
    [list.rows, filter],
  );

  // Per-pill counts, also derived from the cached rows (free, and a useful at-a-
  // glance signal).
  const counts = useMemo(() => {
    const c: Record<RegistrationFilter, number> = {
      all: list.rows.length,
      orphans: 0,
      "pending-verify": 0,
      "verified-no-password": 0,
      "pending-profile": 0,
      completed: 0,
    };
    for (const r of list.rows) {
      c[r.status] += 1;
      if (ORPHAN_STATUSES.includes(r.status)) c.orphans += 1;
    }
    return c;
  }, [list.rows]);

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
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>Registrations</h1>
          <p className={styles.pageLede}>
            Signups across the email and Google sign-up flows. Incomplete ones are
            benign orphans — an email account that never set a password (can&apos;t
            be signed into), or a Google sign-in that never finished a profile —
            and are safe to clean up later. The panel below flags suspicious signup
            activity (bursts, high reCAPTCHA-fail rate, orphan backlog).
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={list.loading || summary.loading}
          onClick={() => {
            void summary.reload();
            list.reload();
          }}
        >
          {list.loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* A thin loading bar so it's obvious the page is fetching (the table is
          empty until the first load resolves). */}
      {(list.loading || summary.loading) && (
        <div className={styles.loadingRow}>
          <span className={styles.loadingBar} aria-hidden="true" />
          <span className={styles.loadingText}>Loading registrations…</span>
        </div>
      )}

      {summary.error ? (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{summary.error}</p>
        </Card>
      ) : summary.summary ? (
        <RegistrationFlags summary={summary.summary} />
      ) : null}

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
            {!list.loading && <span className={styles.filterCount}>{counts[f.value]}</span>}
          </button>
        ))}
      </div>

      {list.error ? (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{list.error}</p>
        </Card>
      ) : list.loading ? null : filtered.length === 0 ? (
        <Card padding="lg">
          <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
            No registrations{filter === "all" ? " yet" : " match this filter"}.
          </p>
        </Card>
      ) : (
        <>
          {list.truncated && (
            <p className={styles.truncatedNote}>
              Showing the first {list.rows.length} registrations. Use the flags
              panel for full counts.
            </p>
          )}
          <div className={styles.list}>
            {filtered.map((r) => (
              <RegistrationRow
                key={r.uid}
                reg={r}
                busy={deletingUid === r.uid}
                onDelete={() => handleDelete(r.uid)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
