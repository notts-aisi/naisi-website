"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import { questionsOf, type WorksheetDoc } from "@/lib/firestore/worksheets";
import styles from "./WorksheetLibrary.module.css";

/**
 * One worksheet in the library.
 *
 * DELETE CONFIRMS IN PLACE rather than through `window.confirm`. The library is
 * a list of similar-looking rows, and a modal dialog that names the worksheet
 * in a sentence is read as "the dialog I always dismiss"; a row that turns into
 * its own question keeps the thing being deleted physically under the button.
 * The editor page's delete is the heavier one (it asks for the title to be
 * typed), because that is the one reached with the worksheet open.
 */

/** "12 Aug 2026". One formatter for both library rows, so the two dates match. */
export function formatDay(date: Date | null): string {
  if (!date) return "not yet saved";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

type Props = {
  worksheet: WorksheetDoc;
  /** Resolved shelf name, or null when the worksheet sits at the top level. */
  folderName: string | null;
  authorName: string;
  /** The author and admins. Everyone else copies instead. */
  canDelete: boolean;
  onDuplicate: () => Promise<void>;
  onDelete: () => Promise<void>;
};

export default function WorksheetRow({
  worksheet,
  folderName,
  authorName,
  canDelete,
  onDuplicate,
  onDelete,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const questions = questionsOf(worksheet.items).length;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          <Link href={`/worksheets/${worksheet.id}`} className={styles.rowTitle}>
            {worksheet.title || "Untitled worksheet"}
          </Link>
          {worksheet.private && (
            <span
              className={styles.lock}
              role="img"
              aria-label="Private"
              title="Private: admins and the author only"
            >
              &#128274;
            </span>
          )}
        </div>
        <div className={styles.rowMeta}>
          <span>{authorName}</span>
          <span>{folderName ?? "No folder"}</span>
          <span>
            {questions} question{questions === 1 ? "" : "s"}
          </span>
          <span>Updated {formatDay(worksheet.updatedAt)}</span>
        </div>
      </div>

      {confirming ? (
        <div className={styles.confirm}>
          <span className={styles.confirmText}>
            Delete this worksheet? Anything already sent keeps its own copy.
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(false)}
            disabled={busy}
          >
            Keep it
          </Button>
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => void run(onDelete)}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      ) : (
        <div className={styles.rowActions}>
          <Link href={`/worksheets/${worksheet.id}`}>
            <Button type="button" size="sm" variant="secondary" disabled={busy}>
              Open
            </Button>
          </Link>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void run(onDuplicate)}
            disabled={busy}
          >
            {busy ? "Copying…" : "Make a copy"}
          </Button>
          {canDelete && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
