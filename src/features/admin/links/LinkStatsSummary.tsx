"use client";

import Button from "@/components/ui/Button";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { STATS_RANGES, type StatsRange } from "./useLinkStats";
import styles from "./links.module.css";

type Totals = { scans: number; signupsStarted: number; signupsConfirmed: number };

type Props = {
  range: StatsRange;
  onRange: (next: StatsRange) => void;
  totals: Totals;
  /** The same three numbers for each kind of link that has any. */
  byType: { label: string; totals: Totals }[];
  loading: boolean;
  error: Error | null;
  onExportTotals: () => void;
  onExportDaily: () => void;
};

/**
 * The headline numbers for the chosen range, above the list.
 *
 * Tiles and not a chart: three numbers are read faster as numbers. The split
 * by kind is a line of text under them for the same reason, since two values
 * do not need a picture.
 */
export function LinkStatsSummary({
  range,
  onRange,
  totals,
  byType,
  loading,
  error,
  onExportTotals,
  onExportDaily,
}: Props) {
  return (
    <section className={styles.summary} aria-label="Scans and sign-ups">
      <div className={styles.summaryHead}>
        <SegmentedControl
          value={range}
          onChange={onRange}
          options={STATS_RANGES}
          ariaLabel="Period"
          size="sm"
        />
        <div className={styles.summaryActions}>
          <Button size="sm" variant="ghost" onClick={onExportTotals} disabled={loading || !!error}>
            Export totals
          </Button>
          <Button size="sm" variant="ghost" onClick={onExportDaily} disabled={loading || !!error}>
            Export by day
          </Button>
        </div>
      </div>

      {error ? (
        <p className={styles.error}>Couldn&apos;t load the numbers: {error.message}</p>
      ) : (
        <>
          <dl className={styles.tiles}>
            <div className={styles.tile}>
              <dt className={styles.tileLabel}>Scans</dt>
              <dd className={styles.tileValue}>{loading ? "…" : totals.scans}</dd>
            </div>
            <div className={styles.tile}>
              <dt className={styles.tileLabel}>Signed up</dt>
              <dd className={styles.tileValue}>{loading ? "…" : totals.signupsStarted}</dd>
            </div>
            <div className={styles.tile}>
              <dt className={styles.tileLabel}>Confirmed</dt>
              <dd className={styles.tileValue}>{loading ? "…" : totals.signupsConfirmed}</dd>
            </div>
          </dl>

          {!loading && byType.length > 1 && (
            <p className={styles.split}>
              {byType.map((kind, i) => (
                <span key={kind.label}>
                  {i > 0 && <span className={styles.figureGap}>·</span>}
                  {kind.label}: <strong>{kind.totals.scans}</strong>{" "}
                  {kind.totals.scans === 1 ? "scan" : "scans"}, <strong>{kind.totals.signupsStarted}</strong>{" "}
                  signed up
                </span>
              ))}
            </p>
          )}

          <p className={styles.note}>
            Scans are a floor, not a total. A scan is counted by the page it lands on, so anyone
            with JavaScript off, or who leaves before the page loads, is missed, and link previews
            and mail scanners are never counted at all. Comparing one code with another is
            reliable. &quot;Signed up&quot; is everyone who submitted the form after a scan;
            &quot;confirmed&quot; is those who then pressed the button in the email.
          </p>
        </>
      )}
    </section>
  );
}
