"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Select from "@/components/ui/Select";
import { Field, Input } from "@/components/ui/Input";
import { downloadCSV, toCSV } from "@/lib/csv";
import {
  useSubscriptions,
  type SubscriptionRow,
  type SubscriptionDisplayStatus,
} from "./useSubscriptions";
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
  /** True iff at least one row for that email is confirmed (sticky once-true on the row schema, so any-row-confirmed === email-verified). */
  emailConfirmed: Record<string, boolean>;
  /** [email][channel] → row */
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
  // Sort channels deterministically (newsletter, events, then alphabetic).
  const channelOrder = (c: string) =>
    c === "newsletter" ? 0 : c === "events" ? 1 : 2;
  for (const g of map.values()) {
    g.channels.sort((a, b) => {
      const ord = channelOrder(a) - channelOrder(b);
      return ord !== 0 ? ord : a.localeCompare(b);
    });
    g.emails.sort();
  }
  return Array.from(map.values());
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
 *  - `subscribed` if any row is subscribed
 *  - `pending` if any row is pending and none subscribed
 *  - `unsubscribed` otherwise (covers unsubscribed and lapsed)
 *  - `none` if no rows exist for this channel (rare for members,
 *    common for guests who only signed up to one channel)
 */
function rollupChannelState(
  recipient: Recipient,
  channel: string,
): { state: "subscribed" | "pending" | "unsubscribed" | "none"; numerator: number; denominator: number } {
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

export default function SubscriptionsTable() {
  const { rows, loading, error } = useSubscriptions();
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [backfillState, setBackfillState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; result: BackfillResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const recipients = useMemo(() => groupRows(rows), [rows]);

  // Auto-expand the pinned recipient (deep-link from members tab) so the
  // admin lands directly on the matrix view for that user.
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

  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.channel);
    return Array.from(set).sort();
  }, [rows]);

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
    return { subscribed, unsubscribed, pending, lapsed, guests, members };
  }, [rows]);

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
          <div>
            <div className={styles.miniCount}>{counts.subscribed}</div>
            <div className={styles.miniLabel}>Subscribed rows</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.pending}</div>
            <div className={styles.miniLabel}>Pending rows</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.unsubscribed}</div>
            <div className={styles.miniLabel}>Unsubscribed rows</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.lapsed}</div>
            <div className={styles.miniLabel}>Lapsed rows</div>
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
          <Field id="sub-search" label="Search by name or email" hint=" ">
            <Input
              id="sub-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Substring match, case-insensitive"
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
              <option value="subscribed">Subscribed</option>
              <option value="pending">Pending</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="lapsed">Lapsed</option>
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
          {pinnedAudienceId && (
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
          )}
          <div className={styles.actions} style={{ marginLeft: "auto" }}>
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
            No recipients match the current filters.
          </p>
        </Card>
      ) : (
        <>
          <div className={styles.recipientList}>
            {pageRecipients.map((r) => (
              <RecipientRow
                key={r.key}
                recipient={r}
                expanded={expanded.has(r.key)}
                onToggle={() => toggleExpand(r.key)}
                channelFilter={channelFilter}
                statusFilter={statusFilter}
                busyId={busyId}
                onToggleSubscribed={onToggleSubscribed}
              />
            ))}
          </div>

          <div className={styles.pagination}>
            <span className={styles.paginationInfo}>
              {filtered.length} recipient{filtered.length === 1 ? "" : "s"} ·{" "}
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

function RecipientRow({
  recipient,
  expanded,
  onToggle,
  channelFilter,
  statusFilter,
  busyId,
  onToggleSubscribed,
}: {
  recipient: Recipient;
  expanded: boolean;
  onToggle: () => void;
  channelFilter: ChannelFilter;
  statusFilter: StatusFilter;
  busyId: string | null;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
}) {
  const filtersActive = channelFilter !== "all" || statusFilter !== "all";

  return (
    <div
      className={`${styles.recipient} ${expanded ? styles.recipientExpanded : ""}`}
    >
      <button
        type="button"
        className={styles.summaryButton}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className={styles.recipientIdentity}>
          <span
            className={`${styles.recipientName} ${
              recipient.name ? "" : styles.recipientNameMuted
            }`}
          >
            {recipient.name || "(no name on file)"}
          </span>
          <span className={styles.recipientAudience}>
            <Badge tone={recipient.audience === "user" ? "accent" : "neutral"}>
              {recipient.audience}
            </Badge>
            {recipient.emails.length} email{recipient.emails.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className={styles.recipientEmails}>
          {recipient.emails.map((email) => {
            const verified = recipient.emailConfirmed[email];
            return (
              <span key={email} className={styles.recipientEmail}>
                <span>{email}</span>
                <span
                  className={
                    verified
                      ? styles.recipientEmailVerified
                      : styles.recipientEmailUnverified
                  }
                  aria-label={verified ? "Verified" : "Not verified"}
                  title={verified ? "Verified" : "Not verified"}
                >
                  {verified ? "✓" : "·"}
                </span>
              </span>
            );
          })}
        </div>
        <div className={styles.recipientPills}>
          {recipient.channels.map((ch) => {
            const roll = rollupChannelState(recipient, ch);
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
                  : roll.state === "unsubscribed"
                    ? styles.statePillUnsubscribed
                    : "";
            const symbol =
              roll.state === "subscribed"
                ? "✓"
                : roll.state === "pending"
                  ? "•"
                  : roll.state === "unsubscribed"
                    ? "✗"
                    : "—";
            return (
              <span
                key={ch}
                className={`${styles.statePill} ${stateClass} ${
                  matched ? styles.statePillMatched : ""
                }`}
                title={pillTitle(ch, roll)}
              >
                <span aria-hidden>{symbol}</span>
                {ch}
                {roll.denominator > 1 && (
                  <span className={styles.muted}>
                    {" "}
                    {roll.numerator}/{roll.denominator}
                  </span>
                )}
              </span>
            );
          })}
        </div>
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
            />
          </div>
        </div>
      </div>
    </div>
  );
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

function RecipientMatrix({
  recipient,
  channelFilter,
  statusFilter,
  busyId,
  onToggleSubscribed,
}: {
  recipient: Recipient;
  channelFilter: ChannelFilter;
  statusFilter: StatusFilter;
  busyId: string | null;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
}) {
  const gridStyle = {
    gridTemplateColumns: `minmax(7rem, max-content) repeat(${recipient.emails.length}, minmax(11rem, 1fr))`,
  };

  return (
    <div className={styles.matrixWrap}>
      <div className={styles.matrix} style={gridStyle}>
        <div />
        {recipient.emails.map((email) => (
          <div key={email} className={styles.matrixHeader}>
            <span className={styles.matrixHeaderEmail}>{email}</span>
            <span className={styles.matrixHeaderMeta}>
              {recipient.emailConfirmed[email] ? "Verified" : "Not verified"}
            </span>
          </div>
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
          />
        ))}
      </div>

      <div className={styles.matrixStacked}>
        {recipient.emails.map((email) => (
          <div key={email} className={styles.matrixStackedEmail}>
            <div className={styles.matrixStackedEmailHeader}>
              <strong>{email}</strong>
              <span className={styles.muted}>
                {recipient.emailConfirmed[email] ? "Verified" : "Not verified"}
              </span>
            </div>
            {recipient.channels.map((ch) => {
              const cell = recipient.cells[email]?.[ch];
              const matched =
                cell && cellMatchesActiveFilters(cell, channelFilter, statusFilter);
              return (
                <div key={ch} className={styles.matrixStackedRow}>
                  <span className={styles.matrixStackedRowLabel}>{ch}</span>
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
        ))}
      </div>
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
}: {
  recipient: Recipient;
  channel: string;
  channelFilter: ChannelFilter;
  statusFilter: StatusFilter;
  busyId: string | null;
  onToggleSubscribed: (cell: SubscriptionRow) => void;
}) {
  return (
    <>
      <div className={styles.matrixChannel}>{channel}</div>
      {recipient.emails.map((email) => {
        const cell = recipient.cells[email]?.[channel];
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
            className={`${styles.matrixCell} ${matched ? styles.matrixCellMatched : ""}`}
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
        {matched && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-accent)" }}>
            match
          </span>
        )}
      </div>
      <div className={styles.matrixCellAudit}>
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
