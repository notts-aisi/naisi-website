"use client";

import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Select from "@/components/ui/Select";
import { downloadCSV, toCSV } from "@/lib/csv";
import {
  useSubscriptions,
  type SubscriptionRow,
} from "./useSubscriptions";
import styles from "./SubscriptionsTable.module.css";

type ChannelFilter = "all" | string;
type StatusFilter = "all" | "pending" | "confirmed" | "unsubscribed";
type AudienceFilter = "all" | "user" | "guest";

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

export default function SubscriptionsTable() {
  const { rows, loading, error } = useSubscriptions();
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>("all");

  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.channel);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (channelFilter !== "all" && r.channel !== channelFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (audienceFilter !== "all" && r.audience !== audienceFilter) return false;
      return true;
    });
  }, [rows, channelFilter, statusFilter, audienceFilter]);

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
          <label>
            Channel
            <Select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
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
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
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
              onChange={(e) => setAudienceFilter(e.target.value as AudienceFilter)}
            >
              <option value="all">All audiences</option>
              <option value="user">Members</option>
              <option value="guest">Guests</option>
            </Select>
          </label>
          <div className={styles.actions} style={{ marginLeft: "auto" }}>
            <Button size="sm" variant="ghost" onClick={onDownload}>
              Download CSV
            </Button>
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>
            No rows match the current filters.
          </p>
        </Card>
      ) : (
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
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
