"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Input } from "@/components/ui/Input";
import {
  ALL_MEMBERSHIP_TIERS,
  MEMBERSHIP_FIELD_LIMITS,
  MEMBERSHIP_TIER_LABELS,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import { currentAcademicYear } from "@/lib/firestore/users";
import { resetCurrentPeriodCache } from "./currentPeriodCache";
import ImportPanel from "./ImportPanel";
import MembershipTable from "./MembershipTable";
import PeriodSwitcher from "./PeriodSwitcher";
import {
  MEMBERSHIP_LIST_MAX_PAGES,
  type MembershipListRow,
} from "./membershipList";
import styles from "./MembershipConsole.module.css";

/**
 * The membership console: the periods, their dates, their per-tier totals, and
 * which one is CURRENT.
 *
 * Four things, in the order somebody works through them: the periods and which
 * one is CURRENT, the period being LOOKED AT, the table of every account
 * against that period, and the SU list import.
 *
 * ## Looking at a period is not making it current
 *
 * The switcher changes what this page shows. `config/membership` decides what
 * every badge on the site reads, is moved by a separate button, and is full
 * admins only. Conflating the two is how somebody re-badges the society while
 * meaning to check last year, so they are two controls that look different.
 *
 * ## Where the counts come from
 *
 * The per-tier counts are the CACHE on the period document, maintained by the
 * grant and commit routes. They are not counted from the table: a headcount
 * that scanned two periods of memberships plus every account on each page load
 * would be slow in exactly the term it matters. "Nothing recorded" and
 * "lapsed" come from the rows the table has loaded, and the table says so.
 *
 * Every read and write is a route call. `membershipPeriods` is
 * `allow read, write: if false`, so there is no client-direct path to fall
 * back on and no snapshot to listen to; the list is refetched after each
 * write.
 */

type Period = {
  id: string;
  year: string;
  label: string;
  startsOn: string;
  endsOn: string;
  note: string;
  totals: Record<MembershipTier, number>;
  createdAt: string | null;
};

type ListPayload = {
  periods: Period[];
  currentPeriodId: string | null;
  canSetCurrent: boolean;
};

export default function MembershipConsole({ isAdmin }: { isAdmin: boolean }) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [currentPeriodId, setCurrentPeriodId] = useState<string | null>(null);
  const [canSetCurrent, setCanSetCurrent] = useState(isAdmin);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The period being LOOKED AT. Empty until the periods land, then the current
  // one, because that is what somebody opening this page came to see.
  const [viewingId, setViewingId] = useState("");
  const [rows, setRows] = useState<MembershipListRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsTruncated, setRowsTruncated] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [recounting, setRecounting] = useState(false);
  const [recountNote, setRecountNote] = useState<string | null>(null);

  /**
   * ONE load, called by the mount effect and again after every write. State
   * moves only from the async callbacks, never synchronously in the effect
   * body: the shape `RoundList` uses, and the reason this is a promise chain
   * rather than an awaited call. `isCancelled` is how the effect's cleanup
   * reaches in.
   */
  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      fetch("/api/admin/membership/periods")
        .then(async (res) => {
          const data = (await res.json()) as ListPayload & { error?: string };
          if (!res.ok) {
            throw new Error(data.error ?? "Could not load the membership periods.");
          }
          return data;
        })
        .then((data) => {
          if (isCancelled()) return;
          setPeriods(data.periods);
          setCurrentPeriodId(data.currentPeriodId);
          setCanSetCurrent(data.canSetCurrent);
          // Only ever a DEFAULT: an admin who has switched to another period
          // stays where they are when this reloads after a write.
          setViewingId((current) => {
            if (current && data.periods.some((p) => p.id === current)) return current;
            return data.currentPeriodId ?? data.periods[0]?.id ?? "";
          });
          setError(null);
        })
        .catch((err: unknown) => {
          if (isCancelled()) return;
          setError(
            err instanceof Error ? err.message : "Could not load the membership periods.",
          );
        })
        .finally(() => {
          if (!isCancelled()) setLoading(false);
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not save.");
      // Creating a period, and above all making one current, changes the
      // answer every membership chip on the Members list is drawn from. That
      // answer is shared and memoised, so it has to be dropped here or the
      // rows keep reporting the state from before this write until a reload.
      resetCurrentPeriodCache();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function patch(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That did not save.");
      // An edit can move the label the chips render, so it drops the shared
      // answer for the same reason a create does.
      resetCurrentPeriodCache();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Every account for the period being viewed, following the cursor to the
   * end. One request per page rather than one per row, and a bounded number of
   * them: a society that grew past the cap is told the table is partial rather
   * than being shown a number that quietly is not the whole list.
   */
  const loadRows = useCallback(
    (periodId: string, isCancelled: () => boolean = () => false) =>
      // Every state change happens in a callback rather than in the body, the
      // shape `load` above uses: state moved synchronously from an effect is
      // a cascading render, and this is called from one.
      Promise.resolve().then(async () => {
        if (!periodId) {
          setRows([]);
          return;
        }
        setRowsLoading(true);
        setRowsTruncated(false);
        const collected: MembershipListRow[] = [];
        let cursor: string | null = null;
        try {
          for (let page = 0; page < MEMBERSHIP_LIST_MAX_PAGES; page += 1) {
            const params = new URLSearchParams({ periodId });
            if (cursor) params.set("cursor", cursor);
            const res = await fetch(`/api/admin/membership/list?${params.toString()}`);
            const data = (await res.json()) as {
              rows: MembershipListRow[];
              nextCursor: string | null;
              error?: string;
            };
            if (!res.ok) throw new Error(data.error ?? "Could not load the accounts.");
            if (isCancelled()) return;
            collected.push(...data.rows);
            cursor = data.nextCursor;
            if (!cursor) break;
            if (page === MEMBERSHIP_LIST_MAX_PAGES - 1) setRowsTruncated(true);
          }
          if (isCancelled()) return;
          setRows(collected);
        } catch (err) {
          if (isCancelled()) return;
          setError(err instanceof Error ? err.message : "Could not load the accounts.");
        } finally {
          if (!isCancelled()) setRowsLoading(false);
        }
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void loadRows(viewingId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadRows, viewingId]);

  /**
   * The export. A POST, because it writes the `dataExports` row that records
   * the download, and a GET would be prefetched and retried. The file is
   * handed over as a blob the browser saves, so the request carries the
   * session cookie the way every other call here does.
   */
  async function exportCsv() {
    if (!viewingId) return;
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/membership/export?periodId=${encodeURIComponent(viewingId)}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That export did not run.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `naisi-membership-${viewingId}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That export did not run.");
    } finally {
      setExporting(false);
    }
  }

  /**
   * Rebuild the four cached tier counts for the period being viewed.
   *
   * The counts are maintained by `increment` from the grant route and each
   * chunk of an import commit, and the commit deliberately does not fail when
   * that update fails. This is the repair for the drift that leaves: it counts
   * the membership rows themselves and writes the answer. Pressing it on a
   * period that was already right writes nothing and says so.
   */
  async function recount() {
    if (!viewingId) return;
    setRecounting(true);
    setRecountNote(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/membership/periods/${encodeURIComponent(viewingId)}/recount`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        corrected?: { tier: MembershipTier; was: number; now: number }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Those totals did not recount.");
      const corrected = data.corrected ?? [];
      setRecountNote(
        corrected.length === 0
          ? "Counted. The totals already agreed with the rows."
          : `Corrected ${corrected
              .map(
                (c) => `${MEMBERSHIP_TIER_LABELS[c.tier]} ${c.was} to ${c.now}`,
              )
              .join(", ")}.`,
      );
      resetCurrentPeriodCache();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Those totals did not recount.");
    } finally {
      setRecounting(false);
    }
  }

  const viewing = periods.find((p) => p.id === viewingId) ?? null;

  return (
    <div className={styles.wrap}>
      <Card padding="lg">
        <h2 className={styles.heading}>Membership periods</h2>
        <p className={styles.blurb}>
          One period per academic year. Marking somebody a member means adding
          them to a period, which is done from their row on the Members tab.
          Membership is a badge and a record: it gates nothing anywhere on the
          site.
        </p>
        {!canSetCurrent && (
          <p className={styles.blurb}>
            Choosing which period is current is an admin job, because it changes
            every member&apos;s badge at once.
          </p>
        )}
      </Card>

      {error && (
        <Card padding="md">
          <p className={styles.error}>{error}</p>
        </Card>
      )}

      <Card padding="lg">
        <div className={styles.sectionHead}>
          <h3 className={styles.subheading}>Periods</h3>
          <Button size="sm" variant="ghost" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New period"}
          </Button>
        </div>

        {creating && (
          <PeriodForm
            busy={busy}
            submitLabel="Create period"
            initial={{
              year: currentAcademicYear(),
              label: "",
              startsOn: "",
              endsOn: "",
              note: "",
            }}
            withYear
            onSubmit={async (values) => {
              const ok = await post("/api/admin/membership/periods", values);
              if (ok) setCreating(false);
            }}
          />
        )}

        {loading ? (
          <p className={styles.muted}>Loading…</p>
        ) : periods.length === 0 ? (
          <p className={styles.muted}>
            No membership periods yet. Create {currentAcademicYear()} and set it
            current, or every badge on the site reads &ldquo;not recorded&rdquo;.
          </p>
        ) : (
          <ul className={styles.list}>
            {periods.map((period) => (
              <li key={period.id} className={styles.row}>
                <div className={styles.rowHead}>
                  <div className={styles.rowTitle}>
                    <strong>{period.label || period.year}</strong>
                    <Badge tone="neutral">{period.year}</Badge>
                    {period.id === currentPeriodId && (
                      <Badge tone="success" title="Every badge on the site is about this period">
                        Current
                      </Badge>
                    )}
                  </div>
                  <div className={styles.rowActions}>
                    {canSetCurrent && period.id !== currentPeriodId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          post("/api/admin/membership/current", { periodId: period.id })
                        }
                      >
                        Make current
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setEditingId((id) => (id === period.id ? null : period.id))
                      }
                    >
                      {editingId === period.id ? "Close" : "Edit"}
                    </Button>
                  </div>
                </div>

                <div className={styles.facts}>
                  <span className={styles.fact}>
                    {period.startsOn || "no start date"} to {period.endsOn || "no end date"}
                  </span>
                  {ALL_MEMBERSHIP_TIERS.map((tier) => (
                    <span key={tier} className={styles.fact}>
                      {MEMBERSHIP_TIER_LABELS[tier]}: {period.totals[tier] ?? 0}
                    </span>
                  ))}
                </div>

                {period.note && <p className={styles.note}>{period.note}</p>}

                {editingId === period.id && (
                  <PeriodForm
                    busy={busy}
                    submitLabel="Save changes"
                    initial={{
                      year: period.year,
                      label: period.label,
                      startsOn: period.startsOn,
                      endsOn: period.endsOn,
                      note: period.note,
                    }}
                    onSubmit={async (values) => {
                      const ok = await patch(
                        `/api/admin/membership/periods/${encodeURIComponent(period.id)}`,
                        {
                          label: values.label,
                          startsOn: values.startsOn,
                          endsOn: values.endsOn,
                          note: values.note,
                        },
                      );
                      if (ok) setEditingId(null);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        <p className={styles.footnote}>
          Membership is a badge and a record: it gates nothing anywhere on the
          site. Recording somebody, changing their tier or taking it back is
          done from the table below, or from their row on the Members page.
        </p>
      </Card>

      {viewing && (
        <Card padding="lg">
          <div className={styles.sectionHead}>
            <h3 className={styles.subheading}>Members</h3>
            <div className={styles.rowActions}>
              <Button
                size="sm"
                variant="ghost"
                disabled={recounting || rowsLoading}
                onClick={recount}
                title="Rebuild the four counts below from the membership rows"
              >
                {recounting ? "Recounting…" : "Recount"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={exporting || rowsLoading}
                onClick={exportCsv}
              >
                {exporting ? "Exporting…" : "Export CSV"}
              </Button>
            </div>
          </div>

          <PeriodSwitcher
            periods={periods}
            value={viewingId}
            currentPeriodId={currentPeriodId}
            onChange={setViewingId}
            disabled={rowsLoading}
          />

          <div className={styles.facts}>
            {ALL_MEMBERSHIP_TIERS.map((tier) => (
              <span key={tier} className={styles.fact}>
                {MEMBERSHIP_TIER_LABELS[tier]}: {viewing.totals[tier] ?? 0}
              </span>
            ))}
          </div>
          <p className={styles.blurb}>
            Those four counts are the period&apos;s own, kept up to date by every
            grant and every import. Everything below is counted from the
            accounts loaded here. If an import ever says it could not move them,
            Recount rebuilds all four from the membership rows.
          </p>
          {recountNote && <p className={styles.blurb}>{recountNote}</p>}
          <p className={styles.blurb}>
            Downloading the CSV is recorded: who took it, which period, and how
            many people were in it.
          </p>

          <MembershipTable
            rows={rows}
            periodId={viewingId}
            loading={rowsLoading}
            truncated={rowsTruncated}
            onRowChanged={(uid, tier) => {
              // The row settles locally rather than re-paging every account to
              // move one of them. The period totals move server-side, so the
              // periods list is refetched for the counts strip.
              setRows((current) =>
                current.map((row) =>
                  row.uid === uid
                    ? {
                        ...row,
                        tier,
                        source: tier ? "manual" : null,
                        matchedOn: tier ? "manual" : null,
                        recordedAt: tier ? new Date().toISOString() : null,
                      }
                    : row,
                ),
              );
              resetCurrentPeriodCache();
              void load();
            }}
          />
        </Card>
      )}

      {viewing && (
        <Card padding="lg">
          <div className={styles.sectionHead}>
            <h3 className={styles.subheading}>Import the SU list</h3>
          </div>
          <ImportPanel
            periodId={viewing.id}
            periodLabel={viewing.label || viewing.year}
            onCommitted={() => {
              resetCurrentPeriodCache();
              void load();
              void loadRows(viewing.id);
            }}
          />
        </Card>
      )}
    </div>
  );
}

type FormValues = {
  year: string;
  label: string;
  startsOn: string;
  endsOn: string;
  note: string;
};

/**
 * Create and edit share one form. The year is editable only on create: it IS
 * the doc id and the string every cached membership year is written against,
 * so changing it later would mean renaming a document and rewriting every
 * badge that points at it.
 */
function PeriodForm({
  initial,
  submitLabel,
  busy,
  withYear = false,
  onSubmit,
}: {
  initial: FormValues;
  submitLabel: string;
  busy: boolean;
  withYear?: boolean;
  onSubmit: (values: FormValues) => void | Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(initial);

  function set(key: keyof FormValues, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(values);
      }}
    >
      {withYear && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Academic year</span>
          <Input
            value={values.year}
            onChange={(e) => set("year", e.target.value)}
            placeholder="2026/27"
            maxLength={7}
          />
        </label>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Label</span>
        <Input
          value={values.label}
          onChange={(e) => set("label", e.target.value)}
          placeholder="Membership 2026/27"
          maxLength={MEMBERSHIP_FIELD_LIMITS.label}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Starts on</span>
        <Input
          type="date"
          value={values.startsOn}
          onChange={(e) => set("startsOn", e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Ends on</span>
        <Input
          type="date"
          value={values.endsOn}
          onChange={(e) => set("endsOn", e.target.value)}
        />
      </label>
      <label className={`${styles.field} ${styles.fieldWide}`}>
        <span className={styles.fieldLabel}>Note (internal)</span>
        {/* Two hundred characters is a sentence or three, not a line, and the
            cap is silent: a single-line input just stops accepting keystrokes.
            The counter is how an admin sees the limit coming. */}
        <CountedTextarea
          value={values.note}
          onChange={(e) => set("note", e.target.value)}
          placeholder="Anything the next admin should know about this year"
          max={MEMBERSHIP_FIELD_LIMITS.note}
          rows={3}
        />
      </label>
      <div className={styles.formActions}>
        <Button type="submit" size="sm" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
