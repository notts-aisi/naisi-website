"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import MemberText from "@/components/ui/MemberText";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import { Textarea } from "@/components/ui/Input";
import {
  ALL_MEMBERSHIP_TIERS,
  MEMBERSHIP_TIER_LABELS,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import type {
  ImportBatchPayload,
  ImportRowPayload,
} from "@/lib/firestore/membershipImports";
import styles from "./ImportPanel.module.css";

/**
 * The SU list: paste it, read what it would do, then commit it.
 *
 * ## Two steps, never one
 *
 * The upload is a DRY RUN. It writes the batch and its rows and reports what
 * matched, and grants nothing. The commit is a second, explicit press. A
 * mis-read column then costs an abandoned batch instead of hundreds of wrong
 * memberships, and an admin can see the shape of the file before believing it.
 *
 * ## Name matches are confirmed one at a time
 *
 * A row matched on name alone will not commit until its tick is on. Two
 * students share a name often enough that this is a real risk, not a
 * hypothetical one, and the server refuses an unconfirmed name row whatever
 * this panel sends. The confirmation is recorded on the row with the name of
 * whoever gave it.
 *
 * ## An import outlives the tab it was started in
 *
 * The batch id used to live only in this component's state, so a reload
 * between the dry run and the commit orphaned the import: the rows were in
 * Firestore and nothing on the site could find them again. The panel now asks
 * the server on mount which imports on this period are unfinished and offers
 * to resume any of them, or to abandon one. Abandoning is a label: it deletes
 * no rows and takes back no membership already committed.
 *
 * ## The confirm list is every page, not the first one
 *
 * The rows GET is paged. Reading one page and stopping meant that on a file
 * with more than two hundred pending rows the name matches past the first page
 * were invisible, so nobody could tick them and the import could never finish.
 * `refresh` follows the cursor to the end.
 *
 * ## The commit is chunked, and the panel keeps pressing
 *
 * Each call commits up to two hundred people and reports what is left, so a
 * six hundred row list is three calls. The loop stops when the server says
 * nothing is remaining, when nothing moved (which means every remaining row is
 * waiting on a confirmation), or when a call fails.
 */

type CommitResponse = {
  committed: number;
  skipped: number;
  failed: number;
  remaining: number;
  awaitingConfirm: number;
  status: string;
  totalsMoved?: boolean;
  results?: { rowId: string; action: string; reason: string }[];
  error?: string;
};

type Receipt = {
  total: number;
  uniEmail: number;
  personalEmail: number;
  needsConfirm: number;
  duplicate: number;
  unmatched: number;
  autoCommittable: number;
  byTier: Record<MembershipTier, number>;
};

type UploadResponse = {
  batchId: string;
  receipt: Receipt;
  accountsScanned: number;
  rows: ImportRowPayload[];
  rowsTruncated: boolean;
  error?: string;
};

/** Pages of rows followed while the confirm list is rebuilt. Two hundred rows
 *  a page against a five thousand row cap, so this reaches the end of the
 *  longest file the upload will accept. */
const ROW_PAGES = 30;

export default function ImportPanel({
  periodId,
  periodLabel,
  onCommitted,
}: {
  periodId: string;
  periodLabel: string;
  onCommitted: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [defaultTier, setDefaultTier] = useState<MembershipTier>("paid");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);
  const [totalsStale, setTotalsStale] = useState(false);
  const [batch, setBatch] = useState<ImportBatchPayload | null>(null);
  const [rows, setRows] = useState<ImportRowPayload[]>([]);
  /** The import being worked on, from a dry run or from a resume. */
  const [batchId, setBatchId] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState<ImportBatchPayload[]>([]);

  function reset() {
    setUpload(null);
    setBatch(null);
    setBatchId(null);
    setRows([]);
    setConfirmed(new Set());
    setProgress(null);
    setTotalsStale(false);
    setError(null);
  }

  /**
   * The imports on this period that are still open. Called on mount and after
   * anything that could close one, because this list is the only route back to
   * an import once the tab that started it is gone.
   */
  const loadUnfinished = useCallback(
    (isCancelled: () => boolean = () => false) =>
      fetch(
        `/api/admin/membership/import?periodId=${encodeURIComponent(periodId)}`,
      )
        .then(async (res) => {
          const data = (await res.json()) as {
            batches?: ImportBatchPayload[];
            error?: string;
          };
          if (!res.ok) throw new Error(data.error ?? "Could not list the imports.");
          return data.batches ?? [];
        })
        .then((batches) => {
          if (!isCancelled()) setUnfinished(batches);
        })
        .catch(() => {
          // A resume list that would not load is not a reason to block the
          // upload underneath it, which is the common path. The panel simply
          // offers nothing to resume.
          if (!isCancelled()) setUnfinished([]);
        }),
    [periodId],
  );

  useEffect(() => {
    let cancelled = false;
    void loadUnfinished(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadUnfinished]);

  async function runDryRun() {
    setBusy(true);
    setError(null);
    setProgress(null);
    setTotalsStale(false);
    try {
      const res = await fetch("/api/admin/membership/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId, csv, filename, defaultTier }),
      });
      const data = (await res.json()) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? "That file could not be read.");
      setUpload(data);
      setBatchId(data.batchId);
      setBatch(null);
      setRows(data.rows);
      setConfirmed(new Set());
      await loadUnfinished();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be read.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Read the batch and EVERY page of its still-pending rows back from the
   * server. The cursor is followed to the end: a name match on page three is
   * one an admin has to be able to tick, and one page was the difference
   * between an import that finishes and one that cannot.
   */
  const refresh = useCallback(async (id: string) => {
    const collected: ImportRowPayload[] = [];
    let cursor: string | null = null;
    let loaded: ImportBatchPayload | null = null;

    for (let page = 0; page < ROW_PAGES; page += 1) {
      const params = new URLSearchParams({ batchId: id });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/admin/membership/import?${params.toString()}`);
      const data = (await res.json()) as {
        batch: ImportBatchPayload;
        rows: ImportRowPayload[];
        nextCursor: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Could not read that import.");
      loaded = data.batch;
      collected.push(...data.rows.filter((row) => row.matchKind === "name"));
      cursor = data.nextCursor;
      if (!cursor) break;
    }

    setBatch(loaded);
    setRows(collected);
    return loaded;
  }, []);

  /** Pick up an import started in another tab, or before a reload. */
  async function resume(id: string) {
    setBusy(true);
    setError(null);
    setProgress(null);
    setTotalsStale(false);
    setUpload(null);
    setConfirmed(new Set());
    try {
      await refresh(id);
      setBatchId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that import.");
    } finally {
      setBusy(false);
    }
  }

  /** Close an import nobody is going back to. Rows and memberships are kept. */
  async function abandon(id: string) {
    const sure = window.confirm(
      "Abandon this import? Nothing is deleted and no membership is taken "
        + "back. It just stops appearing as unfinished.",
    );
    if (!sure) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/membership/import/${encodeURIComponent(id)}/abandon`,
        { method: "POST" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That import was not abandoned.");
      if (batchId === id) reset();
      await loadUnfinished();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That import was not abandoned.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!batchId) return;
    setBusy(true);
    setError(null);
    setTotalsStale(false);
    let totalCommitted = 0;
    let totalSkipped = 0;
    let stale = false;
    try {
      // Up to twenty calls: two hundred people each, so four thousand, which
      // is past the row cap on a single file.
      for (let call = 0; call < 20; call += 1) {
        const res = await fetch(
          `/api/admin/membership/import/${encodeURIComponent(batchId)}/commit`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmedRowIds: [...confirmed] }),
          },
        );
        const data = (await res.json()) as CommitResponse;
        if (!res.ok) throw new Error(data.error ?? "That import did not commit.");
        totalCommitted += data.committed;
        totalSkipped += data.skipped;
        if (data.totalsMoved === false) stale = true;
        setProgress(
          `${totalCommitted} recorded, ${totalSkipped} skipped, `
          + `${data.remaining} left to walk.`,
        );
        const moved = data.committed + data.skipped + data.failed;
        if (data.remaining === 0 || moved === 0) break;
      }
      setTotalsStale(stale);
      await refresh(batchId);
      setConfirmed(new Set());
      await loadUnfinished();
      onCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That import did not commit.");
    } finally {
      setBusy(false);
    }
  }

  // From the dry run when there is one, otherwise from the batch document, so
  // a resumed import shows the same shape of receipt as a fresh upload.
  const receipt: Receipt | null =
    upload?.receipt
    ?? (batch
      ? {
          total: batch.totalRows,
          uniEmail: batch.counts.uniEmail,
          personalEmail: batch.counts.personalEmail,
          needsConfirm: batch.counts.needsConfirm,
          duplicate: batch.counts.duplicate,
          unmatched: batch.counts.unmatched,
          autoCommittable: batch.counts.uniEmail + batch.counts.personalEmail,
          byTier: { paid: 0, comped: 0, alumni: 0, staff: 0 },
        }
      : null);

  const nameRows = rows.filter(
    (row) => row.matchKind === "name" && row.state === "pending",
  );
  const stuck = batch?.status === "writing";

  return (
    <div className={styles.wrap}>
      <p className={styles.blurb}>
        Paste the Students&apos; Union export for {periodLabel}. It is read and
        matched first and records nothing until you press commit. Rows matched
        on a name alone need a tick each: two students share a name more often
        than you would think.
      </p>

      {unfinished.length > 0 && (
        <div className={styles.receipt}>
          <h4 className={styles.receiptHead}>Unfinished imports on this period</h4>
          <p className={styles.blurb}>
            Pick one up where it stopped, or close it. Abandoning deletes
            nothing and takes back no membership already recorded.
          </p>
          {unfinished.map((item) => (
            <div key={item.id} className={styles.resumeRow}>
              <span className={styles.confirmBody}>
                <MemberText
                  text={item.filename || "an unnamed file"}
                  className={styles.confirmName}
                />
                <span className={styles.sub}>
                  {item.totalRows} rows, {item.committedRows} recorded,{" "}
                  {item.awaitingConfirm} waiting on a confirmation, uploaded by{" "}
                  {item.uploadedByName || "somebody"}
                </span>
              </span>
              <Badge tone={item.status === "writing" ? "warning" : "neutral"}>
                {item.status === "writing" ? "Did not finish writing" : item.status}
              </Badge>
              <span className={styles.resumeActions}>
                {item.status !== "writing" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => resume(item.id)}
                  >
                    Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => abandon(item.id)}
                >
                  Abandon
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.controls}>
        <label className={styles.field} htmlFor="import-tier">
          <span className={styles.fieldLabel}>Tier for rows with no type column</span>
          <ResponsiveSelect<MembershipTier>
            id="import-tier"
            value={defaultTier}
            onChange={setDefaultTier}
            disabled={busy}
            ariaLabel="Tier for rows with no type column"
            options={ALL_MEMBERSHIP_TIERS.map<ResponsiveSelectOption<MembershipTier>>(
              (t) => ({ value: t, label: MEMBERSHIP_TIER_LABELS[t] }),
            )}
          />
        </label>
        <label className={styles.field} htmlFor="import-file">
          <span className={styles.fieldLabel}>Or choose the file</span>
          <input
            id="import-file"
            className={styles.file}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFilename(file.name);
              setCsv(await file.text());
              reset();
            }}
          />
        </label>
      </div>

      <label className={styles.field} htmlFor="import-csv">
        <span className={styles.fieldLabel}>The list</span>
        <Textarea
          id="import-csv"
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            if (batchId) reset();
          }}
          rows={6}
          disabled={busy}
          placeholder="name,email,university email,membership type"
        />
      </label>

      <div className={styles.actions}>
        <Button size="sm" disabled={busy || csv.trim() === ""} onClick={runDryRun}>
          Read the file
        </Button>
        {batchId && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={reset}>
            Start again
          </Button>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {receipt && (
        <div className={styles.receipt}>
          <h4 className={styles.receiptHead}>
            {receipt.total} rows read
            {upload ? ` against ${upload.accountsScanned} accounts` : ""}
          </h4>
          <ul className={styles.facts}>
            <li>{receipt.uniEmail} matched on a verified university email</li>
            <li>{receipt.personalEmail} matched on a sign-in email</li>
            <li>{receipt.needsConfirm} matched on a name and need confirming</li>
            <li>{receipt.duplicate} repeated a person from an earlier line</li>
            <li>{receipt.unmatched} have no account here</li>
          </ul>

          {stuck ? (
            <p className={styles.error}>
              This upload did not finish writing its rows, so it cannot be
              committed. Abandon it and read the file again.
            </p>
          ) : (
            <>
              <p className={styles.blurb}>
                Committing now would record {receipt.autoCommittable} memberships,
                plus any name matches you tick.
              </p>

              {nameRows.length > 0 && (
                <div className={styles.confirmList}>
                  <h4 className={styles.receiptHead}>Confirm these name matches</h4>
                  {nameRows.map((row) => (
                    <label key={row.rowId} className={styles.confirmRow}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={confirmed.has(row.rowId)}
                        disabled={busy}
                        onChange={(e) => {
                          setConfirmed((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(row.rowId);
                            else next.delete(row.rowId);
                            return next;
                          });
                        }}
                      />
                      <span className={styles.confirmBody}>
                        {/* Straight off an uploaded file: rendered as a text
                            node, never as markup. */}
                        <MemberText text={row.name} className={styles.confirmName} />
                        <span className={styles.sub}>
                          line {row.line}
                          {row.email ? `, ${row.email}` : ""} to account{" "}
                          {row.matchedUid ?? "unknown"}
                        </span>
                      </span>
                      <Badge tone="warning">Name only</Badge>
                    </label>
                  ))}
                </div>
              )}

              <div className={styles.actions}>
                <Button size="sm" disabled={busy} onClick={commit}>
                  Commit {receipt.autoCommittable + confirmed.size} memberships
                </Button>
                {batchId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => abandon(batchId)}
                  >
                    Abandon this import
                  </Button>
                )}
              </div>
            </>
          )}

          {progress && <p className={styles.blurb}>{progress}</p>}
          {totalsStale && (
            <p className={styles.error}>
              The memberships were written, but this period&apos;s cached
              per-tier counts could not be moved, so the numbers above the table
              are now behind. Press Recount on the Members card to rebuild them
              from the rows.
            </p>
          )}
          {batch && (
            <p className={styles.blurb}>
              This import: {batch.committedRows} recorded, {batch.skippedRows}{" "}
              skipped, {batch.awaitingConfirm} still waiting on a confirmation.
              Status {batch.status}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
