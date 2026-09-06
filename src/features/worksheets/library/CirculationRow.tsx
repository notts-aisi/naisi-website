"use client";

import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import type { CirculationDoc } from "@/lib/firestore/circulations";
import { formatDay } from "./WorksheetRow";
import styles from "./WorksheetLibrary.module.css";

/**
 * One circulation, in the row shape the library already uses.
 *
 * Shared by the "Sent" tab and the editor page's Circulations list on purpose:
 * they are the same list cut two ways (everything I am staff on, everything
 * that came out of THIS worksheet), and a reader who learns the row once should
 * not have to learn it twice.
 *
 * "3 of 8 submitted" rather than a percentage: the sender's real question is
 * how many people are outstanding, and a bar at 37% does not answer it.
 */
export default function CirculationRow({ circulation }: { circulation: CirculationDoc }) {
  const href = `/worksheets/${circulation.worksheetId}/circulations/${circulation.id}`;
  const closed = circulation.status === "closed";

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          <Link href={href} className={styles.rowTitle}>
            {circulation.title || "Untitled worksheet"}
          </Link>
          {closed && <Badge tone="neutral">Closed</Badge>}
        </div>
        <div className={styles.rowMeta}>
          <span>Sent {formatDay(circulation.createdAt)}</span>
          <span>
            {circulation.submittedCount} of {circulation.recipientCount} submitted
          </span>
          {circulation.dueDate && <span>Due {formatDay(circulation.dueDate)}</span>}
        </div>
      </div>
      <div className={styles.rowActions}>
        <Link href={href}>
          <Button type="button" size="sm" variant="secondary">
            Open
          </Button>
        </Link>
      </div>
    </li>
  );
}
