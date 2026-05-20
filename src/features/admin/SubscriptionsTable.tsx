"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { downloadCSV, toCSV } from "@/lib/csv";
import {
  useSubscriptions,
  type SubscriptionRow,
  type SubscriptionDisplayStatus,
} from "./useSubscriptions";
import { useVerifiedEmails } from "./useVerifiedEmails";
import styles from "./SubscriptionsTable.module.css";

type ChannelFilter = "all" | string;
type StatusFilter = "all" | SubscriptionDisplayStatus;
type AudienceFilter = "all" | "user" | "guest";

const PAGE_SIZE = 30;

const STATUS_LABEL: Record<SubscriptionDisplayStatus, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  pending: "Pending",
  lapsed: "Lapsed",
};

/** Newsletter first, events second, anything else after, alphabetic. */
const channelRank = (c: string) =>
  c === "newsletter" ? 0 : c === "events" ? 1 : 2;

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function formatDate(d: Date | null): string {
  if (!d) return "Not set";
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
      "name",
      "email",
      "channel",
      "audience",
      "audienceId",
      "status",
      "confirmed",
      "subscribed",
      "source",
      "createdAt",
      "confirmedAt",
      "subscribedAt",
      "unsubscribedAt",
    ],
    rows.map((r) => [
      r.name,
      r.email,
      r.channel,
      r.audience,
      r.audienceId,
      r.displayStatus,
      r.confirmed,
      r.subscribed,
      r.source,
      r.createdAt?.toISOString() ?? "",
      r.confirmedAt?.toISOString() ?? "",
      r.subscribedAt?.toISOString() ?? "",
      r.unsubscribedAt?.toISOString() ?? "",
    ]),
  );
}

async function setRowSubscribed(id: string, subscribed: boolean): Promise<void> {
  const res = await fetch(`/api/admin/subscriptions/${id}/set-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscribed }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Set-subscribed failed (${res.status})`);
  }
}

async function deleteRow(id: string): Promise<void> {
  const res = await fetch(`/api/admin/subscriptions/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete failed (${res.status})`);
  }
}

type BackfillResult = {
  ok: true;
  usersScanned: number;
  usersWithNoEmail: number;
  memberRowsWritten: number;
  legacyRowsMigrated: number;
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

/**
 * One recipient = one collapsed row. Members are grouped by their uid
 * (so multi-email members collapse to a single row), guests are grouped
 * by email (a guest is identified by their address). Within each group
 * the per-(email, channel) rows form a matrix the expanded view renders.
 */
type Recipient = {
  key: string;
  audience: "user" | "guest";
  audienceId: string;
  name: string;
  emails: string[];
  /** True iff at least one row for that email is confirmed. */
  emailConfirmed: Record<string, boolean>;
  /** [email][channel] -> row */
  cells: Record<string, Record<string, SubscriptionRow>>;
  /** Distinct channels seen across the group's rows. */
  channels: string[];
};

function groupRows(rows: SubscriptionRow[]): Recipient[] {
  const map = new Map<string, Recipient>();
  for (const r of rows) {
    const key = r.audience === "user" ? `u:${r.audienceId}` : `g:${r.email}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        audience: r.audience,
        audienceId: r.audienceId,
        name: r.name,
        emails: [],
        emailConfirmed: {},
        cells: {},
        channels: [],
      };
      map.set(key, group);
    }
    if (!group.name && r.name) group.name = r.name;
    if (!group.emails.includes(r.email)) group.emails.push(r.email);
    if (r.confirmed) group.emailConfirmed[r.email] = true;
    else if (group.emailConfirmed[r.email] === undefined) {
      group.emailConfirmed[r.email] = false;
    }
    if (!group.channels.includes(r.channel)) group.channels.push(r.channel);
    if (!group.cells[r.email]) group.cells[r.email] = {};
    group.cells[r.email][r.channel] = r;
  }
  for (const g of map.values()) {
    g.channels.sort((a, b) => {
      const ord = channelRank(a) - channelRank(b);
      return ord !== 0 ? ord : a.localeCompare(b);
    });
    g.emails.sort();
  }
  return Array.from(map.values());
}

/**
 * Emails on a recipient that are no longer valid: a member row whose
 * email is not in the owning user's current verified-email set, or any
 * member row whose owning user doc is gone. Guests are never stale (a
 * guest IS their email). Returns an empty set until the verified-email
 * index has loaded, so nothing is wrongly flagged mid-load.
 */
function getStaleEmails(
  recipient: Recipient,
  verifiedByUid: Map<string, Set<string>>,
  verifiedLoaded: boolean,
): Set<string> {
  const stale = new Set<string>();
  if (!verifiedLoaded || recipient.audience !== "user") return stale;
  const verified = verifiedByUid.get(recipient.audienceId);
  for (const email of recipient.emails) {
    if (!verified || !verified.has(email)) stale.add(email);
  }
  return stale;
}

function recipientHasMatchingCell(
  recipient: Recipient,
  channelFilter: ChannelFilter,
  statusFilter: StatusFilter,
  audienceFilter: AudienceFilter,
  needle: string,
): boolean {
  if (audienceFilter !== "all" && recipient.audience !== audienceFilter) return false;
  if (
    needle &&
    !recipient.name.toLowerCase().includes(needle) &&
    !recipient.emails.some((e) => e.toLowerCase().includes(needle))
  ) {
    return false;
  }
  if (channelFilter === "all" && statusFilter === "all") return true;
  for (const email of recipient.emails) {
    for (const channel of recipient.channels) {
      const cell = recipient.cells[email]?.[channel];
      if (!cell) continue;
      if (channelFilter !== "all" && cell.channel !== channelFilter) continue;
      if (statusFilter !== "all" && cell.displayStatus !== statusFilter) continue;
      return true;
    }
  }
  return false;
}

function cellMatchesActiveFilters(
  cell: SubscriptionRow,
  channelFilter: ChannelFilter,
  statusFilter: StatusFilter,
): boolean {
  if (channelFilter === "all" && statusFilter === "all") return false;
  if (channelFilter !== "all" && cell.channel !== channelFilter) return false;
  if (statusFilter !== "all" && cell.displayStatus !== statusFilter) return false;
  return true;
}

/**
 * Aggregate cell statuses across a recipient's emails on one channel.
 * Returns the dominant state for the closed-row pill.
 */
function rollupChannelState(
  recipient: Recipient,
  channel: string,
): {
  state: "subscribed" | "pending" | "unsubscribed" | "none";
  numerator: number;
  denominator: number;
} {
  let subscribed = 0;
  let pending = 0;
  let total = 0;
  for (const email of recipient.emails) {
    const cell = recipient.cells[email]?.[channel];
    if (!cell) continue;
    total += 1;
    if (cell.displayStatus === "subscribed") subscribed += 1;
    else if (cell.displayStatus === "pending") pending += 1;
  }
  if (total === 0) return { state: "none", numerator: 0, denominator: 0 };
  if (subscribed > 0) return { state: "subscribed", numerator: subscribed, denominator: total };
  if (pending > 0) return { state: "pending", numerator: pending, denominator: total };
  return { state: "unsubscribed", numerator: 0, denominator: total };
}

function pillTitle(
  channel: string,
  roll: ReturnType<typeof rollupChannelState>,
): string {
  if (roll.state === "none") return `${channel}: no rows on file`;
  if (roll.state === "subscribed")
    return `${channel}: ${roll.numerator} of ${roll.denominator} address(es) subscribed`;
  if (roll.state === "pending")
    return `${channel}: ${roll.numerator} of ${roll.denominator} pending confirmation`;
  return `${channel}: unsubscribed on all ${roll.denominator} address(es)`;
}

export default function SubscriptionsTable() {
  const { rows, loading, error } = useSubscriptions();
  const { verifiedByUid, verifiedLoaded } = useVerifiedEmails();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pinnedAudienceId = searchParams?.get("audienceId") ?? null;

  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  /** `${recipientKey}::${email}` while that stale column is being removed. */
  const [deletingEmail, setDeletingEmail] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [backfillState, setBackfillState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; result: BackfillResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const recipients = useMemo(() => groupRows(rows), [rows]);

  // Channel columns: every distinct channel across all rows, ordered.
  const channelColumns = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.channel);
    return Array.from(set).sort((a, b) => {
      const ord = channelRank(a) - channelRank(b);
      return ord !== 0 ? ord : a.localeCompare(b);
    });
  }, [rows]);

  // Stale email set per recipient, recomputed when rows or the verified
  // index change.
  const staleByKey = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of recipients) {
      m.set(r.key, getStaleEmails(r, verifiedByUid, verifiedLoaded));
    }
    return m;
  }, [recipients, verifiedByUid, verifiedLoaded]);

  // Auto-expand the pinned recipient (deep-link from members tab).
  useEffect(() => {
    if (!pinnedAudienceId) return;
    const target = recipients.find(
      (r) => r.audience === "user" && r.audienceId === pinnedAudienceId,
    );
    if (target) {
      setExpanded((prev) => {
        if (prev.has(target.key)) return prev;
        const next = new Set(prev);
        next.add(target.key);
        return next;
      });
    }
  }, [pinnedAudienceId, recipients]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return recipients.filter((r) => {
      if (pinnedAudienceId) {
        if (r.audience !== "user" || r.audienceId !== pinnedAudienceId) return false;
      }
      return recipientHasMatchingCell(
        r,
        channelFilter,
        statusFilter,
        audienceFilter,
        needle,
      );
    });
  }, [recipients, channelFilter, statusFilter, audienceFilter, search, pinnedAudienceId]);

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
  const pageRecipients = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const counts = useMemo(() => {
    let subscribed = 0;
    let unsubscribed = 0;
    let pending = 0;
    let lapsed = 0;
    let guests = 0;
    let members = 0;
    for (const r of rows) {
      if (r.displayStatus === "subscribed") subscribed += 1;
      else if (r.displayStatus === "unsubscribed") unsubscribed += 1;
      else if (r.displayStatus === "pending") pending += 1;
      else lapsed += 1;
      if (r.audience === "user") members += 1;
      else guests += 1;
    }
    let stale = 0;
    for (const r of recipients) {
      const staleEmails = staleByKey.get(r.key);
      if (!staleEmails) continue;
      for (const email of staleEmails) {
        stale += Object.keys(r.cells[email] ?? {}).length;
      }
    }
    return { subscribed, unsubscribed, pending, lapsed, guests, members, stale };
  }, [rows, recipients, staleByKey]);

  function clearPin() {
    router.replace("/admin/subscriptions");
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onDownload() {
    const stamp = new Date().toISOString().slice(0, 10);
    // CSV exports the underlying per-(email, channel) rows for the
    // recipients currently in view. Not the closed-row aggregate.
    const csvRows: SubscriptionRow[] = [];
    for (const recipient of filtered) {
      for (const email of recipient.emails) {
        const channelMap = recipient.cells[email] ?? {};
        for (const ch of recipient.channels) {
          const cell = channelMap[ch];
          if (cell) csvRows.push(cell);
        }
      }
    }
    downloadCSV(`naisi-subscriptions-${stamp}.csv`, rowsToCSV(csvRows));
  }

  async function onToggleSubscribed(cell: SubscriptionRow) {
    const next = !cell.subscribed;
    setBusyId(cell.id);
    setActionError(null);
    try {
      await setRowSubscribed(cell.id, next);
    } catch (err) {
      console.error(err);
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onDeleteStaleEmail(recipient: Recipient, email: string) {
    const ids = Object.values(recipient.cells[email] ?? {}).map((c) => c.id);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} stale subscription row(s) for ${email}? ` +
          `This removes the ghost column. It does not touch any live subscription.`,
      )
    ) {
      return;
    }
    setDeletingEmail(`${recipient.key}::${email}`);
    setActionError(null);
    try {
      await Promise.all(ids.map((id) => deleteRow(id)));
    } catch (err) {
      console.error(err);
      setActionError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingEmail(null);
    }
  }

  async function onRunBackfill() {
    if (backfillState.kind === "running") return;
    if (
      !window.confirm(
        "Run subscription backfill? Two passes: writes a row per (verified email, channel) for every user, then migrates any legacy-shape rows. Idempotent, safe to re-run.",
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

  // Header + every collapsed row share this template so columns line up.
  const gridTemplate = `minmax(11rem, 1.7fr) 6rem 7rem repeat(${channelColumns.length}, minmax(8rem, 1fr)) 2.75rem`;
  const tableMinWidth = `${11 + 6 + 7 + channelColumns.length * 8 + 2.75 + 3}rem`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div className={styles.summary}>
        <div>
          <div className={styles.bigCount}>{recipients.length}</div>
          <div className={styles.bigLabel}>
            Recipient{recipients.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className={styles.minis}>
          <Mini count={counts.subscribed} label="Subscribed rows" />
          <Mini count={counts.pending} label="Pending rows" />
          <Mini count={counts.unsubscribed} label="Unsubscribed rows" />
          <Mini count={counts.lapsed} label="Lapsed rows" />
          <Mini count={counts.members} label="Member rows" />
          <Mini count={counts.guests} label="Guest rows" />
          <Mini count={counts.stale} label="Stale rows" warn={counts.stale > 0} />
        </div>
      </div>

      <Card padding="md">
        <div className={styles.toolbar}>
          <div className={`${styles.filterField} ${styles.filterFieldGrow}`}>
            <label className={styles.filterLabel} htmlFor="sub-search">
              Search
            </label>
            <Input
              id="sub-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Name or email, case-insensitive"
            />
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="sub-channel">
              Channel
            </label>
            <Select
              id="sub-channel"
              value={channelFilter}
              onChange={(e) => onChannel(e.target.value)}
            >
              <option value="all">All channels</option>
              {channelColumns.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="sub-status">
              Status
            </label>
            <Select
              id="sub-status"
              value={statusFilter}
              onChange={(e) => onStatus(e.target.value as StatusFilter)}
            >
              <option value="all">All statuses</option>
              <option value="subscribed">Subscribed</option>
              <option value="pending">Pending</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="lapsed">Lapsed</option>
            </Select>
          </div>
          <div className={styles.filterField}>
            <label className={styles.filterLabel} htmlFor="sub-audience">
              Audience
            </label>
            <Select
              id="sub-audience"
              value={audienceFilter}
              onChange={(e) => onAudience(e.target.value as AudienceFilter)}
            >
              <option value="all">All audiences</option>
              <option value="user">Members</option>
              <option value="guest">Guests</option>
            </Select>
          </div>
          <div className={styles.toolbarActions}>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRunBackfill}
              disabled={backfillState.kind === "running"}
              title="Two-pass migration: writes a row per (verified email, channel) for every user, then converts any legacy-shape rows to the new schema. Idempotent."
            >
              {backfillState.kind === "running" ? "Running…" : "Run backfill"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDownload}>
              Download CSV
            </Button>
          </div>
        </div>

        {pinnedAudienceId && (
          <div className={styles.pinnedRow}>
            <span className={styles.pinnedFilter}>
              Pinned to one user
              <button
                type="button"
                className={styles.pinnedFilterClear}
                onClick={clearPin}
                aria-label="Clear pinned filter"
              >
                ×
              </button>
            </span>
          </div>
        )}

        {backfillState.kind === "done" && (
          <p className={styles.toolbarNote}>
            Backfill complete. Scanned {backfillState.result.usersScanned} user
            {backfillState.result.usersScanned === 1 ? "" : "s"}, wrote{" "}
            {backfillState.result.memberRowsWritten} member row
            {backfillState.result.memberRowsWritten === 1 ? "" : "s"}, migrated{" "}
            {backfillState.result.legacyRowsMigrated} legacy row
            {backfillState.result.legacyRowsMigrated === 1 ? "" : "s"}
            {backfillState.result.usersWithNoEmail > 0
              ? `, skipped ${backfillState.result.usersWithNoEmail} user(s) without email`
              : ""}
            .
          </p>
        )}
        {backfillState.kind === "error" && (
          <p className={`${styles.toolbarNote} ${styles.toolbarNoteError}`}>
            {backfillState.message}
          </p>
        )}
      </Card>

      {actionError && (
        <Card padding="sm">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{actionError}</p>
        </Card>
      )}

      {filtered.length === 0 ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>
            No recipients match the current filters.
          </p>
        </Card>
      ) : (
        <>
          <div className={styles.tableScroll}>
            <div className={styles.tableInner} style={{ minWidth: tableMinWidth }}>
              <div
                className={styles.tableHeader}
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <span>Recipient</span>
                <span>Audience</span>
                <span>Emails</span>
                {channelColumns.map((c) => (
                  <span key={c}>{titleCase(c)}</span>
                ))}
                <span aria-hidden />
              </div>
              <div className={styles.recipientList}>
                {pageRecipients.map((r) => (
                  <RecipientRow
                    key={r.key}
                    recipient={r}
                    expanded={expanded.has(r.key)}
                    onToggle={() => toggleExpand(r.key)}
                    channelColumns={channelColumns}
                    channelFilter={channelFilter}
                    statusFilter={statusFilter}
                    busyId={busyId}
                    onToggleSubscribed={onToggleSubscribed}
                    staleEmails={staleByKey.get(r.key) ?? new Set()}
                    deletingEmail={deletingEmail}
                    onDeleteStaleEmail={onDeleteStaleEmail}
                    gridTemplate={gridTemplate}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className={styles.pagination}>
            <span className={styles.paginationInfo}>
              {filtered.length} recipient{filtered.length === 1 ? "" : "s"} ·
              Showing {pageStart + 1} to{" "}
              {Math.min(pageStart + PAGE_SIZE, filtered.length)}
            </span>
            <div className={styles.paginationActions}>
              <Button
                size="sm"
                variant="ghost"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                Prev
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
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Mini({
  count,
  label,
  warn,
}: {
  count: number;
  label: string;
  warn?: boolean;
}) {
  return (
    <div>
      <div
        className={`${styles.miniCount} ${warn ? styles.miniCountWarn : ""}`}
      >
        {count}
      </div>
      <div className={styles.miniLabel}>{label}</div>
    </div>
  );
}

function RecipientRow({
  recipient,
  expanded,
  onToggle,
  channelColumns,
  channelFilter,
  statusFilter,
  busyId,
  onToggleSubscribed,
  staleEmails,
  deletingEmail,
  onDeleteStaleEmail,
  gridTemplate,
}: {
  recipient: Recipient;
  expanded: boolean;
  onToggle: () => void;
  channelColumns: string[];
  channelFilter: ChannelFilter;
  statusFilter: StatusFilter;
  busyId: string | null;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
  staleEmails: Set<string>;
  deletingEmail: string | null;
  onDeleteStaleEmail: (recipient: Recipient, email: string) => void;
  gridTemplate: string;
}) {
  const filtersActive = channelFilter !== "all" || statusFilter !== "all";
  const hasStale = staleEmails.size > 0;

  return (
    <div
      className={`${styles.recipient} ${expanded ? styles.recipientExpanded : ""} ${
        hasStale ? styles.recipientStale : ""
      }`}
    >
      <button
        type="button"
        className={styles.summaryButton}
        style={{ gridTemplateColumns: gridTemplate }}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={styles.cellName}>
          <span
            className={`${styles.recipientName} ${
              recipient.name ? "" : styles.recipientNameMuted
            }`}
          >
            {recipient.name || "(no name on file)"}
          </span>
          {hasStale && (
            <span className={styles.staleChip} title="Has a stale orphan row">
              stale
            </span>
          )}
        </span>

        <span className={styles.cellAudience}>
          <Badge tone={recipient.audience === "user" ? "accent" : "neutral"}>
            {recipient.audience}
          </Badge>
        </span>

        <span className={styles.cellEmails}>
          {recipient.emails.length} email{recipient.emails.length === 1 ? "" : "s"}
          {hasStale && (
            <span className={styles.cellEmailsStale}>
              {staleEmails.size} stale
            </span>
          )}
        </span>

        {channelColumns.map((ch) => {
          const roll = rollupChannelState(recipient, ch);
          if (roll.state === "none") {
            return (
              <span key={ch} className={styles.cellChannelEmpty} title={`${ch}: no rows`}>
                ·
              </span>
            );
          }
          const matched =
            filtersActive &&
            (channelFilter === "all" || channelFilter === ch) &&
            (statusFilter === "all" ||
              statusFilter === roll.state ||
              (statusFilter === "lapsed" && roll.state === "unsubscribed"));
          const stateClass =
            roll.state === "subscribed"
              ? styles.statePillSubscribed
              : roll.state === "pending"
                ? styles.statePillPending
                : styles.statePillUnsubscribed;
          const symbol =
            roll.state === "subscribed"
              ? "✓"
              : roll.state === "pending"
                ? "•"
                : "✗";
          return (
            <span key={ch} className={styles.cellChannel}>
              <span
                className={`${styles.statePill} ${stateClass} ${
                  matched ? styles.statePillMatched : ""
                }`}
                title={pillTitle(ch, roll)}
              >
                <span aria-hidden>{symbol}</span>
                {roll.denominator > 1
                  ? `${roll.numerator}/${roll.denominator}`
                  : STATUS_LABEL[roll.state]}
              </span>
            </span>
          );
        })}

        <span
          aria-hidden
          className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
        >
          ▾
        </span>
      </button>

      <div className={`${styles.panel} ${expanded ? styles.panelOpen : ""}`}>
        <div className={styles.panelInner}>
          <div className={styles.panelBody}>
            <RecipientMatrix
              recipient={recipient}
              channelFilter={channelFilter}
              statusFilter={statusFilter}
              busyId={busyId}
              onToggleSubscribed={onToggleSubscribed}
              staleEmails={staleEmails}
              deletingEmail={deletingEmail}
              onDeleteStaleEmail={onDeleteStaleEmail}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function RecipientMatrix({
  recipient,
  channelFilter,
  statusFilter,
  busyId,
  onToggleSubscribed,
  staleEmails,
  deletingEmail,
  onDeleteStaleEmail,
}: {
  recipient: Recipient;
  channelFilter: ChannelFilter;
  statusFilter: StatusFilter;
  busyId: string | null;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
  staleEmails: Set<string>;
  deletingEmail: string | null;
  onDeleteStaleEmail: (recipient: Recipient, email: string) => void;
}) {
  const gridStyle = {
    gridTemplateColumns: `minmax(7rem, max-content) repeat(${recipient.emails.length}, minmax(12rem, 1fr))`,
  };

  return (
    <div className={styles.matrixWrap}>
      <div className={styles.matrix} style={gridStyle}>
        <div />
        {recipient.emails.map((email) => (
          <EmailHeader
            key={email}
            recipient={recipient}
            email={email}
            stale={staleEmails.has(email)}
            deleting={deletingEmail === `${recipient.key}::${email}`}
            onDeleteStaleEmail={onDeleteStaleEmail}
          />
        ))}

        {recipient.channels.map((ch) => (
          <RecipientMatrixChannelRow
            key={ch}
            recipient={recipient}
            channel={ch}
            channelFilter={channelFilter}
            statusFilter={statusFilter}
            busyId={busyId}
            onToggleSubscribed={onToggleSubscribed}
            staleEmails={staleEmails}
          />
        ))}
      </div>

      <div className={styles.matrixStacked}>
        {recipient.emails.map((email) => {
          const stale = staleEmails.has(email);
          return (
            <div
              key={email}
              className={`${styles.matrixStackedEmail} ${
                stale ? styles.matrixStackedEmailStale : ""
              }`}
            >
              <div className={styles.matrixStackedEmailHeader}>
                <strong>{email}</strong>
                <span className={styles.muted}>
                  {recipient.emailConfirmed[email] ? "Verified" : "Not verified"}
                </span>
                {stale && (
                  <StaleHeaderNote
                    recipient={recipient}
                    email={email}
                    deleting={deletingEmail === `${recipient.key}::${email}`}
                    onDeleteStaleEmail={onDeleteStaleEmail}
                  />
                )}
              </div>
              {recipient.channels.map((ch) => {
                const cell = recipient.cells[email]?.[ch];
                const matched =
                  cell && cellMatchesActiveFilters(cell, channelFilter, statusFilter);
                return (
                  <div key={ch} className={styles.matrixStackedRow}>
                    <span className={styles.matrixStackedRowLabel}>
                    {titleCase(ch)}
                  </span>
                    {cell ? (
                      <CellContents
                        cell={cell}
                        matched={Boolean(matched)}
                        busy={busyId === cell.id}
                        onToggleSubscribed={onToggleSubscribed}
                      />
                    ) : (
                      <span className={styles.matrixCellMissing}>No row</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmailHeader({
  recipient,
  email,
  stale,
  deleting,
  onDeleteStaleEmail,
}: {
  recipient: Recipient;
  email: string;
  stale: boolean;
  deleting: boolean;
  onDeleteStaleEmail: (recipient: Recipient, email: string) => void;
}) {
  return (
    <div
      className={`${styles.matrixHeader} ${stale ? styles.matrixHeaderStale : ""}`}
    >
      <span className={styles.matrixHeaderEmail}>{email}</span>
      <span className={styles.matrixHeaderMeta}>
        {recipient.emailConfirmed[email] ? "Verified" : "Not verified"}
      </span>
      {stale && (
        <StaleHeaderNote
          recipient={recipient}
          email={email}
          deleting={deleting}
          onDeleteStaleEmail={onDeleteStaleEmail}
        />
      )}
    </div>
  );
}

function StaleHeaderNote({
  recipient,
  email,
  deleting,
  onDeleteStaleEmail,
}: {
  recipient: Recipient;
  email: string;
  deleting: boolean;
  onDeleteStaleEmail: (recipient: Recipient, email: string) => void;
}) {
  return (
    <div className={styles.staleNote}>
      <span className={styles.staleNoteText}>
        Not a verified email for this account. This column is a ghost left
        behind by an email change.
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={deleting}
        onClick={() => onDeleteStaleEmail(recipient, email)}
      >
        {deleting ? "Removing…" : "Remove ghost column"}
      </Button>
    </div>
  );
}

function RecipientMatrixChannelRow({
  recipient,
  channel,
  channelFilter,
  statusFilter,
  busyId,
  onToggleSubscribed,
  staleEmails,
}: {
  recipient: Recipient;
  channel: string;
  channelFilter: ChannelFilter;
  statusFilter: StatusFilter;
  busyId: string | null;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
  staleEmails: Set<string>;
}) {
  return (
    <>
      <div className={styles.matrixChannel}>{titleCase(channel)}</div>
      {recipient.emails.map((email) => {
        const cell = recipient.cells[email]?.[channel];
        const stale = staleEmails.has(email);
        if (!cell) {
          return (
            <div key={email} className={styles.matrixCellMissing}>
              No row
            </div>
          );
        }
        const matched = cellMatchesActiveFilters(cell, channelFilter, statusFilter);
        return (
          <div
            key={email}
            className={`${styles.matrixCell} ${matched ? styles.matrixCellMatched : ""} ${
              stale ? styles.matrixCellStale : ""
            }`}
          >
            <CellContents
              cell={cell}
              matched={matched}
              busy={busyId === cell.id}
              onToggleSubscribed={onToggleSubscribed}
            />
          </div>
        );
      })}
    </>
  );
}

function CellContents({
  cell,
  matched,
  busy,
  onToggleSubscribed,
}: {
  cell: SubscriptionRow;
  matched: boolean;
  busy: boolean;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
}) {
  const tone =
    cell.displayStatus === "subscribed"
      ? "success"
      : cell.displayStatus === "pending"
        ? "warning"
        : "neutral";
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Badge tone={tone}>{STATUS_LABEL[cell.displayStatus]}</Badge>
        {matched && <span className={styles.matchTag}>match</span>}
      </div>
      <div className={styles.matrixCellAudit}>
        <span>Source: {cell.source || "unknown"}</span>
        <span>Created: {formatDate(cell.createdAt)}</span>
        <span>Confirmed: {formatDate(cell.confirmedAt)}</span>
        <span>Subscribed: {formatDate(cell.subscribedAt)}</span>
        <span>Unsubscribed: {formatDate(cell.unsubscribedAt)}</span>
      </div>
      <Button
        size="sm"
        variant={cell.subscribed ? "ghost" : "primary"}
        disabled={busy}
        onClick={() => onToggleSubscribed(cell)}
      >
        {busy ? "…" : cell.subscribed ? "Unsubscribe" : "Re-subscribe"}
      </Button>
    </>
  );
}
