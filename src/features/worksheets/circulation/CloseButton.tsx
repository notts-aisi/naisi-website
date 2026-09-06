"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import type { CirculationDoc } from "@/lib/firestore/circulations";
import styles from "./CirculationActions.module.css";

/**
 * "That's enough": stop this circulation taking answers, and take its cards
 * off everybody's board.
 *
 * ── THE CONFIRM NAMES BOTH CONSEQUENCES, AND THE ONE THAT IS NOT UNDOABLE ───
 * Closing is two things at once, and only the first is the one people think
 * they are doing. Answers stop being accepted (anybody mid-worksheet keeps
 * what they typed but cannot submit it), AND every recipient's task is
 * archived, which is a card disappearing off somebody else's board without
 * them touching it. A dialog that said only "close this?" would be asking
 * about the half the person already knows.
 *
 * It also says there is no reopen in this version, because there is not, and
 * finding that out afterwards is the kind of thing that makes people distrust
 * every other button on a page.
 *
 * ── ALREADY CLOSED IS A DISABLED BUTTON, NOT A HIDDEN ONE ───────────────────
 * The same reasoning the page uses elsewhere: a control that vanishes reads as
 * a feature that does not exist, and somebody then goes looking for another
 * way to do the thing that has already happened. Disabled, with the reason in
 * the tooltip.
 */

type Props = {
  circulation: CirculationDoc;
};

export default function CloseButton({ circulation }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closed = circulation.status === "closed";

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/worksheets/circulations/${encodeURIComponent(circulation.id)}/close`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; archivedTasks?: number; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? `This circulation is still open (${res.status}).`);
        return;
      }
      // No success message: the page is listening to the circulation document,
      // so the status chip flips and this button greys out on its own. A toast
      // saying what the screen already shows is one more thing to dismiss.
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This circulation is still open.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.action}>
      {/* A disabled button swallows its own mouse events in some browsers, so
          the tooltip rides on the wrapper rather than on the button. */}
      <span
        title={closed ? "This circulation is already closed." : undefined}
        className={styles.tooltipHost}
      >
        <Button
          type="button"
          variant="secondary"
          onClick={() => setConfirming(true)}
          disabled={closed}
        >
          {closed ? "Closed" : "Close"}
        </Button>
      </span>

      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}

      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(false)}
          ariaLabel="Close this circulation"
          width="sm"
        >
          <div className={styles.dialog}>
            <h2 className={styles.dialogTitle}>Close this circulation?</h2>
            <p className={styles.dialogBody}>
              Nobody will be able to submit their answers after this, including anybody
              part-way through: what they have written stays saved, but the Submit button
              goes. Every recipient&apos;s task is archived, so the card comes off their
              board.
            </p>
            <p className={styles.dialogBody}>
              You will still be able to read and export everything that came in. There is
              no way to reopen it in this version.
            </p>
            <div className={styles.dialogActions}>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Keep it open
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void run()}
                disabled={busy}
              >
                {busy ? "Closing…" : "Close it"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </span>
  );
}
