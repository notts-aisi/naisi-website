"use client";

import { useState } from "react";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { ENROLMENT_LIMITS } from "@/lib/firestore/courseEnrolments";
import styles from "./DropOutCard.module.css";

/**
 * Leaving a course, behind a typed confirmation of the course title.
 *
 * ── WHY THE RITUAL ──────────────────────────────────────────────────────────
 * This is the only member-facing action in the courses feature that the
 * person taking it cannot undo: the enrolment row lives at a deterministic id
 * that survives the drop, so re-enrolling is something staff have to do. A
 * plain confirm dialog is one mis-tap on a phone away from that. Typing the
 * course title is the same ritual the destroy routes use, and the server
 * checks it too (byte equality) rather than trusting this form.
 *
 * ── THE REASON BOX ──────────────────────────────────────────────────────────
 * Optional, always. It goes to the staff review surface and is never shown
 * back to the cohort. The anonymous form offered afterwards is the other half
 * of the same question and is deliberately separate: this box is attached to
 * a name, that one is not, and somebody who will not write the first may well
 * write the second.
 *
 * ── THE CONFIRMATION IS NOT THIS COMPONENT'S TO SHOW ────────────────────────
 * It used to be, and it was never once seen: the moment `onDropped` fires,
 * the picker re-reads, the member's row comes back `withdrawn`, and the
 * branch that renders this card is gone along with the card. So the "you're
 * off the course" line and the feedback link live in the parent, which is the
 * component still on screen afterwards, and this one hands the URL up.
 */

type Props = {
  runId: string;
  courseTitle: string;
  /**
   * Called once the drop has committed, with the anonymous feedback URL the
   * route hands back (empty string when no admin has configured one). The
   * parent renders the confirmation: see the note above.
   */
  onDropped: (feedbackUrl: string) => void;
};

export default function DropOutCard({ runId, courseTitle, onDropped }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Byte equality, matching the server. Nothing is trimmed or lower-cased on
  // either side: a ritual that accepts an approximation is not a ritual.
  const confirmed = confirmName === courseTitle;

  async function drop() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/courses/runs/${encodeURIComponent(runId)}/enrol`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmName,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        feedbackUrl?: string;
      } | null;
      if (!res.ok) {
        setError(body?.error ?? "Couldn't take you off the course just now.");
        return;
      }
      // Up to the parent, which is what stays on screen: somebody who has
      // just left should see that it worked, and be asked once, gently.
      onDropped(body?.feedbackUrl ?? "");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className={styles.card}>
        <button
          type="button"
          className={styles.reveal}
          onClick={() => setOpen(true)}
        >
          Leave this course
        </button>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <p className={styles.warning}>
        Leaving frees your place for somebody else and stops the emails. It
        can&apos;t be undone from here: coming back means asking the team.
      </p>

      <label className={styles.label} htmlFor="dropout-reason">
        Anything you&apos;d like us to know? (optional)
      </label>
      <CountedTextarea
        id="dropout-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        max={ENROLMENT_LIMITS.dropOutReason}
        rows={3}
        placeholder="Clashes with a lab, too much on this term, not what I expected..."
      />

      <label className={styles.label} htmlFor="dropout-confirm">
        Type <span className={styles.title}>{courseTitle}</span> to confirm
      </label>
      <input
        id="dropout-confirm"
        className={styles.input}
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.danger}
          disabled={!confirmed || busy}
          onClick={() => void drop()}
        >
          {busy ? "Leaving..." : "Leave the course"}
        </button>
        <button
          type="button"
          className={styles.cancel}
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setConfirmName("");
            setReason("");
            setError(null);
          }}
        >
          Stay on it
        </button>
      </div>
    </div>
  );
}
