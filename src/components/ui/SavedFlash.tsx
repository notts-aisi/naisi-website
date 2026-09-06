"use client";

import { useEffect, useState } from "react";
import styles from "./SavedFlash.module.css";

export type SaveState = "idle" | "saving" | "saved" | "error";

// 120ms in / 1400ms hold / 200ms out. The in/out halves are CSS (and collapse
// under reduced motion); the hold is here because it is read time, not motion.
const IN_MS = 120;
const HOLD_MS = 1400;
const OUT_MS = 200;

const ERROR_MESSAGE = "Couldn't save — your last change isn't stored.";

/**
 * Inline feedback for keep-working saves: check-offs, ratings, autosave.
 *
 * The parent owns `state` as the save *result* and may leave it at "saved"
 * indefinitely; the flash owns its own lifetime and returns to visually idle
 * on an internal timer. A fresh flash therefore needs the state to leave
 * "saved" and come back (idle → saving → saved), which is what every real
 * save cycle does.
 *
 * Errors are the exception: they persist until the parent clears them, since
 * the member needs to know the change didn't land.
 */
export default function SavedFlash({ state }: { state: SaveState }) {
  const [phase, setPhase] = useState<"in" | "out" | "gone">("gone");

  useEffect(() => {
    if (state !== "saved") return;
    // Deliberate set-state-in-effect (same pattern as AppShell's sign-in
    // entrance): the flash starts on the transition into "saved", and there is
    // no event to hang it off — the parent's state change is the event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase("in");
    const out = window.setTimeout(() => setPhase("out"), IN_MS + HOLD_MS);
    const gone = window.setTimeout(() => setPhase("gone"), IN_MS + HOLD_MS + OUT_MS);
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(gone);
    };
  }, [state]);

  const showSaved = state === "saved" && phase !== "gone";

  return (
    <span className={styles.root} role="status" aria-live="polite">
      {state === "saving" && <span className={styles.saving}>Saving…</span>}
      {showSaved && (
        <span className={phase === "out" ? `${styles.saved} ${styles.leaving}` : styles.saved}>
          <span className={styles.check} aria-hidden="true">
            ✓
          </span>
          Saved
        </span>
      )}
      {state === "error" && <span className={styles.error}>{ERROR_MESSAGE}</span>}
    </span>
  );
}
