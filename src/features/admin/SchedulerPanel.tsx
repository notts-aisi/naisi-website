"use client";

import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Switch from "@/components/ui/Switch";
// Type-only imports of firebase-admin inside that module are erased at build
// time, so pulling the one bucket formatter into a client component is safe
// and keeps the panel and the receipt id speaking the same language.
import { formatBucketKey } from "@/lib/firestore/schedulerRuns";
import styles from "./SchedulerPanel.module.css";

/**
 * Admin view of the scheduler tick (`POST /api/scheduler/tick`).
 *
 * The observability bar this panel exists to clear: before the application
 * window opens, an admin must be able to answer "is the scheduler running",
 * "which jobs are on", "did anything throw" and "is a send stuck" from a
 * SURFACE rather than from server logs. Everything below is one of those four
 * questions.
 *
 * `schedulerRuns` and `schedulerMarkers` are shut to every client in
 * firestore.rules, so this reads through GET /api/admin/scheduler rather than
 * streaming Firestore the way the other admin tabs do. That also means no
 * live updates: there is a Refresh button, and the tick only fires every 15
 * minutes, so a listener would be showing a still frame anyway.
 */

type JobRow = {
  id: string;
  label: string;
  description: string;
  maxPerTick: number;
  maxLateHours: number;
  reclaimAfterMinutes: number;
  enabled: boolean;
  /** What no stored switch means for this job. False = it ships dark. */
  enabledByDefault: boolean;
  lastRunAt: string | null;
  lastProcessed: number;
  lastError: string | null;
  lastErrorAt: string | null;
};

type ReceiptJob = {
  id: string;
  processed: number;
  hasMore: boolean;
  durationMs: number;
  error: string | null;
  skipped: string | null;
};

type ReceiptRow = {
  id: string;
  bucket: string;
  depth: number;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  hasMore: boolean;
  rearmed: boolean;
  rearmNote: string | null;
  skipped: string | null;
  receiptCollision: boolean;
  jobs: ReceiptJob[];
};

type MarkerRow = {
  id: string;
  job: string;
  family: string | null;
  attempts: number;
  claimedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  components: Record<string, string>;
};

type ServerState = {
  enabled: boolean;
  updatedAt: string | null;
  jobs: JobRow[];
  receipts: ReceiptRow[];
  failedMarkers: MarkerRow[];
};

/**
 * Every instant on this panel, in UTC and labelled UTC.
 *
 * The receipt bucket is floored in UTC and rendered as a UTC label by
 * `formatBucketKey`, and the external scheduler is armed on `Etc/UTC`. An
 * unlabelled local time next to those is not a smaller inconsistency than it
 * looks: for half the year London is an hour ahead, so a job that last ran in
 * the 08:45 bucket would read "09:47" beside it, and the obvious reading of
 * that pair is that the tick fired an hour late.
 *
 * So the whole panel speaks one clock. It is an admin debugging surface read
 * next to Cloud Logging and gcloud, both of which default to UTC too; the
 * places that show a member a time are elsewhere and keep local time.
 */
function formatWhen(iso: string | null): string {
  if (iso === null) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const rendered = date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${rendered} UTC`;
}

function receiptSummary(receipt: ReceiptRow): string {
  if (receipt.skipped === "disabled") return "scheduler off";
  if (receipt.skipped === "no-jobs") return "no jobs ran";
  if (receipt.jobs.length === 0) return "no jobs";
  return receipt.jobs
    .map((job) => {
      if (job.error !== null) return `${job.id}: error`;
      if (job.skipped !== null) return `${job.id}: ${job.skipped}`;
      return `${job.id}: ${job.processed}`;
    })
    .join(", ");
}

export default function SchedulerPanel() {
  const [state, setState] = useState<ServerState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/scheduler", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as
        | (ServerState & { error?: string })
        | null;
      if (!res.ok || !body || !Array.isArray(body.jobs)) {
        setLoadError(body?.error ?? "Couldn't load the scheduler state.");
        return;
      }
      setState(body);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load the scheduler state.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // The async IIFE is not decoration: calling `load()` directly here trips
    // the cascading-render lint, because the effect would then own a
    // synchronous path into setState.
    void (async () => {
      await load();
    })();
  }, [load]);

  async function post(
    path: string,
    body: Record<string, unknown>,
    busyKey: string,
  ) {
    setBusy(busyKey);
    setActionError(null);
    setActionNote(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!res.ok || data?.ok !== true) {
        setActionError(
          typeof data?.error === "string"
            ? data.error
            : "That didn't go through.",
        );
        return;
      }
      if (typeof data.note === "string") setActionNote(data.note);
      else if (typeof data.processed === "number") {
        setActionNote(`Ran ${busyKey}: ${data.processed} handled.`);
      }
      await load();
    } catch {
      setActionError("That didn't go through.");
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) {
    return (
      <Card>
        <p className={styles.empty}>Loading the scheduler state.</p>
      </Card>
    );
  }

  if (state === null) {
    return (
      <Card>
        <p className={styles.error}>
          {loadError ?? "Couldn't load the scheduler state."}
        </p>
      </Card>
    );
  }

  const lastReceipt = state.receipts[0] ?? null;

  return (
    <div className={styles.stack}>
      <Card>
        <div className={styles.head}>
          <h2 className={styles.sectionTitle}>Scheduler</h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            Refresh
          </Button>
        </div>
        <p className={styles.blurb}>
          An external scheduler calls the tick every 15 minutes. Each tick runs
          the jobs below in order within one time budget; anything it does not
          finish is picked up by the next call, because every job works out what
          is due from live data rather than from a queue. Sends are guarded by
          a marker written before the send, so a repeated tick sends nothing
          twice.
        </p>
        <Switch
          size="lg"
          checked={state.enabled}
          disabled={busy !== null}
          label="Scheduler enabled"
          description={
            state.enabled
              ? "Ticks run the job list. This is the normal state."
              : "Ticks still arrive and still leave a receipt, but no job runs. Nothing time-based is being sent."
          }
          onChange={(next) =>
            void post("/api/admin/scheduler/config", { enabled: next }, "global")
          }
        />
        <p className={styles.jobMeta}>
          <span>
            Last tick:{" "}
            {lastReceipt === null
              ? "none recorded yet"
              : `${formatBucketKey(lastReceipt.bucket)} (depth ${lastReceipt.depth}, ${lastReceipt.durationMs}ms)`}
          </span>
        </p>
        {actionError !== null && <p className={styles.error}>{actionError}</p>}
        {actionNote !== null && <p className={styles.note}>{actionNote}</p>}
        {loadError !== null && <p className={styles.error}>{loadError}</p>}
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>Jobs</h2>
        <p className={styles.blurb}>
          Registration order is run order. Run now ignores a job&rsquo;s own
          switch, so you can test one without turning it back on for the
          scheduler.
        </p>
        <ul className={styles.jobList}>
          {state.jobs.map((job) => (
            <li key={job.id} className={styles.jobRow}>
              <div className={styles.jobMain}>
                <Switch
                  checked={job.enabled}
                  disabled={busy !== null}
                  label={job.label}
                  onChange={(next) =>
                    void post(
                      "/api/admin/scheduler/config",
                      { jobs: { [job.id]: { enabled: next } } },
                      job.id,
                    )
                  }
                />
                <p className={styles.jobDescription}>{job.description}</p>
                <div className={styles.jobMeta}>
                  <span className={styles.mono}>{job.id}</span>
                  <span>Last run: {formatWhen(job.lastRunAt)}</span>
                  <span>Last handled: {job.lastProcessed}</span>
                  <span>Cap: {job.maxPerTick} per tick</span>
                  {job.maxLateHours > 0 && (
                    <span>Skips work over {job.maxLateHours}h late</span>
                  )}
                </div>
                {!job.enabled && !job.enabledByDefault && (
                  <p className={styles.jobDescription}>
                    This job emails people, so it does not switch itself on
                    when it deploys. Turn it on here once you have watched a
                    run on dev.
                  </p>
                )}
                {job.lastError !== null && (
                  <p className={styles.jobError}>
                    Threw at {formatWhen(job.lastErrorAt)}: {job.lastError}
                  </p>
                )}
              </div>
              <div className={styles.jobActions}>
                <Badge tone={job.enabled ? "success" : "neutral"}>
                  {job.enabled ? "On" : "Off"}
                </Badge>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null || !state.enabled}
                  onClick={() =>
                    void post(
                      "/api/admin/scheduler/run",
                      { jobId: job.id },
                      job.id,
                    )
                  }
                >
                  Run now
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>Stuck sends</h2>
        <p className={styles.blurb}>
          A marker is claimed just before a send and stamped just after. One
          that never got its stamp is retried automatically a couple of times;
          after that it lands here and waits for you. Retry clears it so the
          next tick works the send out again from scratch.
        </p>
        {state.failedMarkers.length === 0 ? (
          <p className={styles.empty}>
            Nothing stuck. Every claimed send has been stamped.
          </p>
        ) : (
          <ul className={styles.jobList}>
            {state.failedMarkers.map((marker) => (
              <li key={marker.id} className={styles.markerRow}>
                <div className={styles.jobMain}>
                  <div className={styles.markerId}>{marker.id}</div>
                  <div className={styles.markerMeta}>
                    {marker.job || "unknown job"} &middot; {marker.attempts}{" "}
                    attempt{marker.attempts === 1 ? "" : "s"} &middot; gave up{" "}
                    {formatWhen(marker.failedAt)}
                    {marker.lastError !== null && <> &middot; {marker.lastError}</>}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void post(
                      "/api/admin/scheduler/run",
                      { markerId: marker.id },
                      marker.id,
                    )
                  }
                >
                  Retry
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>Recent ticks</h2>
        <p className={styles.blurb}>
          One row per call. A depth above 0 is the tick calling itself to carry
          on with work it ran out of time for.
        </p>
        {state.receipts.length === 0 ? (
          <p className={styles.empty}>
            No ticks recorded. If the external scheduler is armed, check that
            its key matches and that it is pointed at /api/scheduler/tick.
          </p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>Depth</th>
                  <th>Trigger</th>
                  <th>Took</th>
                  <th>Jobs</th>
                  <th>More</th>
                </tr>
              </thead>
              <tbody>
                {state.receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className={styles.mono}>{formatBucketKey(receipt.bucket)}</td>
                    <td>{receipt.depth}</td>
                    <td>{receipt.trigger}</td>
                    <td>
                      {receipt.finishedAt === null
                        ? "did not finish"
                        : `${receipt.durationMs}ms`}
                    </td>
                    <td className={styles.wrapCell}>{receiptSummary(receipt)}</td>
                    <td className={styles.wrapCell}>
                      {receipt.hasMore
                        ? (receipt.rearmNote ?? "yes")
                        : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
