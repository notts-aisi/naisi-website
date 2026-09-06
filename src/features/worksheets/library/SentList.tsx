"use client";

import EmptyState from "@/components/ui/EmptyState";
import { useMyCirculations } from "@/features/worksheets/hooks/useMyCirculations";
import CirculationRow from "./CirculationRow";
import styles from "./WorksheetLibrary.module.css";

/**
 * The "Sent" tab: every circulation the viewer is STAFF on.
 *
 * Wider than "sent by me", deliberately. A reviewer who was named on somebody
 * else's circulation, and an author whose worksheet somebody else circulated,
 * both have work waiting here, and neither of them holds
 * `circulateWorksheet`. Gating the tab on that key would hide the reviewer's
 * queue from the reviewer.
 */
export default function SentList({ viewerUid }: { viewerUid: string }) {
  const { circulations, loading, error } = useMyCirculations(viewerUid);

  if (loading) return <p className={styles.hint}>Loading…</p>;
  if (error) {
    return (
      <p className={styles.error}>
        Couldn&apos;t load your circulations: {error.message}
      </p>
    );
  }
  if (circulations.length === 0) {
    return (
      <EmptyState
        title="Nothing sent yet."
        body="Open a worksheet and circulate it, and it will show up here with who has answered."
      />
    );
  }

  return (
    <ul className={styles.rows}>
      {circulations.map((circulation) => (
        <CirculationRow key={circulation.id} circulation={circulation} />
      ))}
    </ul>
  );
}
