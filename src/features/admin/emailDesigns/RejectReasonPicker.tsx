"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import {
  REJECTION_REASONS,
  type RejectionReasonKey,
} from "@/lib/firestore/applicationEmails";
import styles from "./RejectReasonPicker.module.css";

type Props = {
  onCancel: () => void;
  onConfirm: (reasonKey: RejectionReasonKey, customReason?: string) => Promise<void> | void;
  busy?: boolean;
};

const REASON_ORDER: RejectionReasonKey[] = [
  "not-member",
  "not-in-nottingham",
  "suspected-spam",
  "custom",
];

export default function RejectReasonPicker({ onCancel, onConfirm, busy }: Props) {
  const [selected, setSelected] = useState<RejectionReasonKey | null>(null);
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!selected) {
      setError("Pick a reason.");
      return;
    }
    if (selected === "custom" && customReason.trim().length === 0) {
      setError("Write a custom reason, or pick a different option.");
      return;
    }
    setError(null);
    await onConfirm(selected, selected === "custom" ? customReason.trim() : undefined);
  }

  return (
    <div className={styles.panel} role="group" aria-label="Rejection reason">
      <h3>Reject with reason</h3>
      <div className={styles.options}>
        {REASON_ORDER.map((key) => (
          <label key={key} className={styles.option}>
            <input
              type="radio"
              name="rejection-reason"
              value={key}
              checked={selected === key}
              onChange={() => setSelected(key)}
              disabled={busy}
            />
            <span>{REJECTION_REASONS[key].label}</span>
          </label>
        ))}
      </div>

      {selected === "custom" && (
        <div className={styles.customBox}>
          <textarea
            className={styles.textarea}
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            placeholder="What should we tell them? e.g. &quot;Please reach out to us on Instagram to chat.&quot;"
            maxLength={2000}
            disabled={busy}
          />
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={busy}>
          {busy ? "Rejecting…" : "Confirm rejection"}
        </Button>
      </div>
    </div>
  );
}
