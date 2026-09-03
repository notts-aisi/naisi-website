"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import styles from "./SendRemindersNow.module.css";

/**
 * The manual lane for the deadline reminders, on the round page.
 *
 * The scheduler tick sends these on its own. This is here because the dates
 * that matter are few and named, and a slipped tick on one of them is a
 * missed deadline rather than a late email. It calls the SAME handler the
 * tick calls, scoped to this round, so it cannot double-send: anybody the
 * tick already mailed holds a stamped marker and is skipped.
 *
 * ## Two presses, deliberately
 *
 * The first press asks. Sending mail to everyone holding a draft is not
 * undoable, and this button sits directly under a list of number inputs
 * somebody has just been editing, which is exactly the place a stray click
 * lands. The confirmation names what will happen rather than asking "are you
 * sure".
 *
 * ## The receipt is the point
 *
 * "Sent" alone would leave the presser wondering whether anything happened.
 * The three numbers are the honest answer, including the two that are usually
 * zero: `skipped` covers suppressed addresses and opt-outs, and `stale` means
 * a due date was too old to mail, which is the one outcome somebody pressing
 * this button on a slipped tick needs to see.
 *
 * What it deliberately does NOT show is a count of who is left. The run only
 * ever loaded a page of the audience, and most of those may already hold a
 * stamped marker from an earlier press, so any such number would read "150
 * still to go" in front of a second press that sends nothing. "There may be
 * more: press again" is what the run actually knows.
 */
export default function SendRemindersNow({
  roundId,
  disabled,
}: {
  roundId: string;
  /** True while the round is not open, so the server would refuse anyway. */
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const res = await fetch(
        `/api/admissions/rounds/${encodeURIComponent(roundId)}/reminders/send-now`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(
          typeof body.error === "string" && body.error
            ? body.error
            : `That did not send (${res.status}).`,
        );
      }
      const n = (key: string) => (typeof body[key] === "number" ? body[key] : 0);
      const parts = [
        `${n("sent")} sent`,
        `${n("skipped")} skipped`,
        `${n("stale")} too late to send`,
      ];
      if (n("failed") > 0) parts.push(`${n("failed")} failed`);
      // Not a count of what is left. The run knows only what it loaded, and
      // most of that may already have been sent on an earlier press, so a
      // number here would read "150 still to go" and then send nothing.
      const more = body.hasMore === true ? " There may be more: press again." : "";
      setReceipt(`${parts.join(", ")}.${more}`);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {!confirming ? (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || busy}
          onClick={() => {
            setReceipt(null);
            setError(null);
            setConfirming(true);
          }}
        >
          Send due reminders now
        </Button>
      ) : (
        <div className={styles.confirm}>
          <p className={styles.question}>
            This emails everyone still holding an unsubmitted draft, for every
            reminder date that has already come round. Anyone already emailed for
            that date is skipped, so nobody gets it twice.
          </p>
          <div className={styles.actions}>
            <Button type="button" onClick={send} disabled={busy}>
              {busy ? "Sending…" : "Send them"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {receipt && <p className={styles.receipt}>{receipt}</p>}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
