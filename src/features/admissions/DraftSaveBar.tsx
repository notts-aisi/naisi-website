"use client";

import { useEffect, useRef } from "react";
import Button from "@/components/ui/Button";
import styles from "./DraftSaveBar.module.css";

/**
 * The draft's save bar: an explicit Save, a two-minute autosave while dirty,
 * a "saved at" flash, and a guard against closing the tab mid-sentence.
 *
 * ## Why an autosave AND a button
 *
 * The owner asked for both, and they answer different fears. The autosave is
 * for the phone that gets backgrounded on a bus; the button is for the person
 * who wants to KNOW it saved before they close the laptop. A silent autosave
 * on its own leaves somebody staring at a form with no evidence their evening
 * survived, which is the anxiety that makes people paste their answers into a
 * notes app.
 *
 * ## The timer is armed by dirtiness, not by the clock
 *
 * A save fires 120 seconds after the form first becomes dirty, and the timer
 * is cleared on every successful save. So a form nobody is touching makes no
 * requests at all, and a form being typed into saves at most once every two
 * minutes however fast the typing is.
 *
 * `beforeunload` is only registered WHILE dirty. Registering it always would
 * put a browser confirmation in front of somebody who has changed nothing,
 * which trains people to click through the one that matters.
 */

export const AUTOSAVE_INTERVAL_MS = 120_000;

type Props = {
  dirty: boolean;
  saving: boolean;
  /** ISO instant of the last successful save, or null. */
  savedAt: string | null;
  /** Resolves true when the save landed. */
  onSave: () => Promise<boolean>;
  disabled?: boolean;
};

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export default function DraftSaveBar({
  dirty,
  saving,
  savedAt,
  onSave,
  disabled,
}: Props) {
  /**
   * The latest `onSave`, parked in a ref INSIDE an effect (never during
   * render). The autosave timer must not restart every time the parent
   * re-renders with a new closure, which on a form being typed into is every
   * keystroke: a timer that resets on each character would never fire.
   */
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  });

  useEffect(() => {
    if (!dirty || disabled) return;
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, disabled, savedAt]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers ignore custom text now and show their own sentence; the
      // assignment is still what arms the dialog in older engines.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <div className={styles.bar}>
      <p className={styles.status} aria-live="polite">
        {saving
          ? "Saving..."
          : dirty
            ? "Unsaved changes. This saves itself every couple of minutes."
            : savedAt
              ? `Saved at ${timeLabel(savedAt)}.`
              : "Your answers are saved to your account as you go."}
      </p>
      {/* The flash is a REMOUNT, not a piece of state: the key changes when a
          save lands, React replaces the node, and the CSS animation replays
          and settles at zero opacity. No timer, no setState in an effect, and
          nothing to clean up if the component unmounts mid-fade. */}
      {savedAt && !dirty && !saving ? (
        <span key={savedAt} className={styles.flash} aria-hidden="true">
          Saved
        </span>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        onClick={() => void onSave()}
        disabled={disabled || saving || !dirty}
      >
        {saving ? "Saving" : "Save draft"}
      </Button>
    </div>
  );
}
