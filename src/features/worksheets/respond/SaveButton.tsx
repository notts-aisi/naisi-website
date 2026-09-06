"use client";

import { useEffect, useState } from "react";
import type { DebouncedWriteState } from "@/hooks/useDebouncedWrite";
import styles from "./SaveButton.module.css";

/**
 * Save, for a page that is already saving by itself.
 *
 * The autosave is the real mechanism; this button exists because a person who
 * has just written three paragraphs wants to press something. So it does
 * exactly what the autosave does (flush what is pending) and spends its effort
 * on SAYING SO: a spinner while the write is in flight, then solid green with
 * a tick for two seconds, then back to neutral.
 *
 * WHY IT RETURNS TO NEUTRAL. A button that stays green is a button that says
 * "saved" about a change made after it. The flash marks the moment the write
 * landed and then stops making a claim, which is also why the hold is short
 * enough to catch and long enough to read.
 *
 * The error state is deliberately NOT painted here. A failed save gets a
 * sentence that stays on screen (the route's own words), and a red button
 * beside it would be a second, quieter version of the same news that
 * disappears the moment anybody types.
 */

/** Long enough to notice, short enough not to lie about a later change. */
const FLASH_MS = 2000;

type Props = {
  state: DebouncedWriteState;
  /** Flush the pending write. The caller owns what "save" means. */
  onSave: () => void;
  disabled?: boolean;
  className?: string;
};

export default function SaveButton({ state, onSave, disabled, className }: Props) {
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (state !== "saved") return;
    // Deliberate set-state-in-effect, the same shape as SavedFlash: the flash
    // begins on the TRANSITION into "saved", and the parent's state change is
    // the only event there is to hang it off.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const saving = state === "saving";
  const showSaved = flashing && state === "saved";

  return (
    <button
      type="button"
      className={[styles.button, showSaved ? styles.saved : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      onClick={onSave}
      disabled={disabled || saving}
    >
      {saving && <span className={styles.spinner} aria-hidden="true" />}
      {showSaved && (
        <span className={styles.tick} aria-hidden="true">
          ✓
        </span>
      )}
      {saving ? "Saving…" : showSaved ? "Saved" : "Save"}
    </button>
  );
}
