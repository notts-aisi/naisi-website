"use client";

import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Select from "@/components/ui/Select";
import { Field, Input } from "@/components/ui/Input";
import { downloadCSV, toCSV } from "@/lib/csv";
import {
  useSubscriptions,
  type SubscriptionRow,
} from "./useSubscriptions";
import styles from "./SubscriptionsTable.module.css";

type ChannelFilter = "all" | string;
type StatusFilter = "all" | "pending" | "confirmed" | "unsubscribed";
type AudienceFilter = "all" | "user" | "guest";

const PAGE_SIZE = 30;

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rowsToCSV(rows: SubscriptionRow[]): string {
  return toCSV(
    [
      "email",
      "channel",
      "audience",
      "audienceId",
      "status",
      "source",
      "createdAt",
      "confirmedAt",
      "unsubscribedAt",
    ],
    rows.map((r) => [
      r.email,
      r.channel,
      r.audience,
      r.audienceId,
      r.status,
      r.source,
      r.createdAt?.toISOString() ?? "",
      r.confirmedAt?.toISOString() ?? "",
      r.unsubscribedAt?.toISOString() ?? "",
    ]),
  );
}

async function setRowStatus(
  id: string,
  status: "confirmed" | "unsubscribed" | "pending",
): Promise<void> {
  const res = await fetch(`/api/admin/subscriptions/${id}/set-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Set-status failed (${res.status})`);
  }
}

type BackfillResult = {
  ok: true;
  usersScanned: number;
  rowsWritten: number;
  usersWithNoEmail: number;
};

async function runBackfill(): Promise<BackfillResult> {
  const res = await fetch("/api/admin/backfill-subscriptions", { method: "POST" });
  const body = (await res.json().catch(() => null)) as BackfillResult | { error: string } | null;
  if (!res.ok || !body || "error" in body) {
    const msg =
      (body && "error" in body && body.error) || `Backfill failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

export default function SubscriptionsTable() {
  const { rows, loading, error } = useSubscriptions();
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [backfillState, setBackfillState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; result: BackfillResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.channel);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (channelFilter !== "all" && r.channel !== channelFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (audienceFilter !== "all" && r.audience !== audienceFilter) return false;
      if (needle && !r.email.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, channelFilter, statusFilter, audienceFilter, search]);

  // Wrap each filter setter so changing a filter also resets to page 0.
  // Lifting this out of a useEffect avoids the project's set-state-in-effect
  // lint rule and is functionally identical — every filter change goes
  // through one of these.
  const onSearch = (v: string) => {
    setSearch(v);
    setPage(0);
  };
  const onChannel = (v: ChannelFilter) => {
    setChannelFilter(v);
    setPage(0);
  };
  const onStatus = (v: StatusFilter) => {
    setStatusFilter(v);
    setPage(0);
  };
  const onAudience = (v: AudienceFilter) => {
    setAudienceFilter(v);
    setPage(0);
  };

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const counts = useMemo(() => {
    let confirmed = 0;
    let pending = 0;
    let unsubscribed = 0;
    let guests = 0;
    let members = 0;
    for (const r of rows) {
      if (r.status === "confirmed") confirmed += 1;
      else if (r.status === "pending") pending += 1;
      else unsubscribed += 1;
      if (r.audience === "user") members += 1;
      else guests += 1;
    }
    return { confirmed, pending, unsubscribed, guests, members };
  }, [rows]);

  function onDownload() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`naisi-subscriptions-${stamp}.csv`, rowsToCSV(filtered));
  }

  async function onToggleStatus(row: SubscriptionRow) {
    const next: "confirmed" | "unsubscribed" =
      row.status === "unsubscribed" ? "confirmed" : "unsubscribed";
    setBusyId(row.id);
    setActionError(null);
    try {
      await setRowStatus(row.id, next);
    } catch (err) {
      console.error(err);
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onRunBackfill() {
    if (backfillState.kind === "running") return;
    if (
      !window.confirm(
        "Run subscription backfill? Reads every user doc and creates / refreshes a subscription row for each active newsletter or events pref. Idempotent, safe to re-run.",
      )
    ) {
      return;
    }
    setBackfillState({ kind: "running" });
    try {
      const result = await runBackfill();
      setBackfillState({ kind: "done", result });
    } catch (err) {
      console.error(err);
      setBackfillState({
        kind: "error",
        message: err instanceof Error ? err.message : "Backfill failed",
      });
    }
  }

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading subscriptions…</p>
      </Card>
    );
  }
  if (error) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t load subscriptions: {error.message}
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div className={styles.summary}>
        <div>
          <div className={styles.bigCount}>{rows.length}</div>
          <div className={styles.bigLabel}>
            Subscription row{rows.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className={styles.minis}>
          <div>
            <div className={styles.miniCount}>{counts.confirmed}</div>
            <div className={styles.miniLabel}>Confirmed</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.pending}</div>
            <div className={styles.miniLabel}>Pending</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.unsubscribed}</div>
            <div className={styles.miniLabel}>Unsubscribed</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.members}</div>
            <div className={styles.miniLabel}>Member rows</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.guests}</div>
            <div className={styles.miniLabel}>Guest rows</div>
          </div>
        </div>
      </div>

      <Card padding="md">
        <div className={styles.toolbar}>
          <Field id="sub-search" label="Search by email" hint=" ">
            <Input
              id="sub-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Substring match — case-insensitive"
            />
          </Field>
          <label>
            Channel
            <Select
              value={channelFilter}
              onChange={(e) => onChannel(e.target.value)}
            >
              <option value="all">All channels</option>
              {channelOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Status
            <Select
              value={statusFilter}
              onChange={(e) => onStatus(e.target.value as StatusFilter)}
            >
              <option value="all">All statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="pending">Pending</option>
              <option value="unsubscribed">Unsubscribed</option>
            </Select>
          </label>
          <label>
            Audience
            <Select
              value={audienceFilter}
              onChange={(e) => onAudience(e.target.value as AudienceFilter)}
            >
              <option value="all">All audiences</option>
              <option value="user">Members</option>
              <option value="guest">Guests</option>
            </Select>
          </label>
          <div className={styles.actions} style={{ marginLeft: "auto" }}>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRunBackfill}
              disabled={backfillState.kind === "running"}
              title="Reads every user doc and ensures their subscription rows match their notification prefs. Idempotent."
            >
              {backfillState.kind === "running" ? "Running…" : "Run backfill"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDownload}>
              Download CSV
            </Button>
          </div>
        </div>
        {backfillState.kind === "done" && (
          <p
            style={{
              marginTop: "var(--space-3)",
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
            }}
          >
            Backfill complete. Scanned {backfillState.result.usersScanned} user
            {backfillState.result.usersScanned === 1 ? "" : "s"}, wrote{" "}
            {backfillState.result.rowsWritten} row
            {backfillState.result.rowsWritten === 1 ? "" : "s"}
            {backfillState.result.usersWithNoEmail > 0
              ? `, skipped ${backfillState.result.usersWithNoEmail} user(s) without email`
              : ""}
            .
          </p>
        )}
        {backfillState.kind === "error" && (
          <p
            style={{
              marginTop: "var(--space-3)",
              color: "var(--color-danger)",
              fontSize: "var(--text-sm)",
            }}
          >
            {backfillState.message}
          </p>
        )}
      </Card>

      {actionError && (
        <Card padding="sm">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>
            {actionError}
          </p>
        </Card>
      )}

      {filtered.length === 0 ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>
            No rows match the current filters.
          </p>
        </Card>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Channel</th>
                  <th>Audience</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Created</th>
                  <th>Confirmed</th>
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.email}</td>
                    <td>
                      <Badge tone="neutral">{r.channel}</Badge>
                    </td>
                    <td>
                      <Badge tone={r.audience === "user" ? "accent" : "neutral"}>
                        {r.audience}
                      </Badge>
                    </td>
                    <td>
                      <Badge
                        tone={
                          r.status === "confirmed"
                            ? "success"
                            : r.status === "pending"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className={styles.muted}>{r.source}</td>
                    <td className={styles.muted}>{formatDate(r.createdAt)}</td>
                    <td className={styles.muted}>{formatDate(r.confirmedAt)}</td>
                    <td>
                      <Button
                        size="sm"
                        variant={r.status === "unsubscribed" ? "primary" : "ghost"}
                        disabled={busyId === r.id}
                        onClick={() => onToggleStatus(r)}
                      >
                        {busyId === r.id
                          ? "…"
                          : r.status === "unsubscribed"
                            ? "Re-activate"
                            : "Deactivate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.pagination}>
            <span className={styles.paginationInfo}>
              {filtered.length} match{filtered.length === 1 ? "" : "es"} ·{" "}
              Showing {pageStart + 1}
              {"–"}
              {Math.min(pageStart + PAGE_SIZE, filtered.length)}
            </span>
            <div className={styles.paginationActions}>
              <Button
                size="sm"
                variant="ghost"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                ← Prev
              </Button>
              <span className={styles.muted}>
                Page {safePage + 1} / {pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                Next →
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
