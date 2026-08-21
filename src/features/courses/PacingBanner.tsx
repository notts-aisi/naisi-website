"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CurrentWeek } from "@/lib/courses/weekPlan";
import { setWeekNavDirection } from "./weekNavDirection";
import styles from "./PacingBanner.module.css";

/**
 * The week page's pacing note: where the cohort is relative to the week being
 * viewed. Informational, NEVER an alarm — tones are neutral (behind / break)
 * and success (ahead), and danger is deliberately impossible here: being on a
 * different week is a fact about reading order, not a failure state (plan:
 * "Placement map — Week page", tones success/neutral/warning, never danger).
 *
 * Hidden entirely when the member is on the cohort's week, outside the
 * running phase, or after a per-(run, week) session dismissal. sessionStorage
 * rather than localStorage on purpose: pacing is a today-shaped fact, and a
 * note dismissed last term should come back next visit.
 */

type Props = {
  runId: string;
  /** The week number of the page this banner sits on. */
  viewedWeek: number;
  /** Server-recomputed; null on a draft/undated run (banner hides). */
  currentWeek: CurrentWeek | null;
};

type Variant = {
  tone: "neutral" | "success";
  text: string;
  /** Optional jump target ("Go to Week N"). */
  targetWeek: number | null;
};

function variantFor(viewedWeek: number, cw: CurrentWeek | null): Variant | null {
  if (!cw || cw.phase !== "running") return null;
  if (cw.breakLabel) {
    // During a break there is no "on-track" week; the anchor (last taught
    // week that started) is the jump target when it isn't the page itself.
    const anchor = cw.anchorWeekNumber;
    return {
      tone: "neutral",
      text: `It's ${cw.breakLabel} for your cohort — no new week right now.`,
      targetWeek: anchor >= 1 && anchor !== viewedWeek ? anchor : null,
    };
  }
  const week = cw.weekNumber;
  if (week === null || week === viewedWeek) return null;
  if (viewedWeek < week) {
    return {
      tone: "neutral",
      text: `Your cohort is on Week ${week} — this is an earlier week.`,
      targetWeek: week,
    };
  }
  return {
    tone: "success",
    text: `You're looking ahead — your cohort is on Week ${week}.`,
    targetWeek: week,
  };
}

/** sessionStorage can throw (Safari private mode); a banner is not worth it. */
function readDismissed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Dismissal just won't survive a reload.
  }
}

/** How long the grid-rows close takes before unmount (--dur-panel + slack). */
const CLOSE_MS = 320;

export default function PacingBanner({ runId, viewedWeek, currentWeek }: Props) {
  const storageKey = `naisi:pacing-dismissed:${runId}:${viewedWeek}`;
  const [dismissed, setDismissed] = useState(() => readDismissed(storageKey));
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const variant = variantFor(viewedWeek, currentWeek);
  const show = variant !== null && !dismissed;

  useEffect(() => {
    if (!show) return;
    // The PublicMain rAF handshake: first paint commits the 0fr from-state,
    // the next frame opens it, so the grid-rows entrance actually runs.
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [show]);

  if (!show) return null;

  const dismiss = () => {
    writeDismissed(storageKey);
    setLeaving(true);
    // Unmount after the close transition; a late fire after page unmount is
    // a no-op setState, harmless by construction.
    window.setTimeout(() => setDismissed(true), CLOSE_MS);
  };

  const jump = variant.targetWeek;

  return (
    <div className={open && !leaving ? `${styles.shell} ${styles.shellOpen}` : styles.shell}>
      <div className={styles.inner}>
        <div role="status" className={`${styles.banner} ${styles[variant.tone]}`}>
          <p className={styles.text}>
            {variant.text}
            {jump !== null && (
              <Link
                href={`/learn/${encodeURIComponent(runId)}/weeks/${jump}`}
                className={styles.jump}
                onClick={() =>
                  setWeekNavDirection(jump > viewedWeek ? "left" : "right")
                }
              >
                Go to Week {jump}
              </Link>
            )}
          </p>
          <button
            type="button"
            className={styles.dismiss}
            aria-label="Dismiss pacing note"
            onClick={dismiss}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
