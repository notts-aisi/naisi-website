"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Trailing-edge debounced writer for keep-working autosave — the shared engine
 * behind "type and it saves itself" surfaces (weekly exercise answers first;
 * anything else with a free-text field and a route behind it next).
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * `push(value)` schedules a write `delayMs` after the LAST push. Pushes made
 * while the timer runs coalesce: only the newest value is ever written, so a
 * member typing a paragraph pays one request, not one per keystroke.
 *
 * `cancel()` drops a scheduled write that has NOT gone out yet — the timer and
 * the queued value both. It is the counterpart to `push` for a caller that
 * decides the value it queued is no longer worth writing (a field cleared back
 * to nothing stored, a URL edited into invalidity): without it, "return early
 * instead of pushing" silently leaves the PREVIOUS value scheduled, and the
 * writer lands something the box no longer shows. The rule for callers is
 * absolute: every change either pushes what the box now holds or cancels.
 * `cancel()` cannot recall a request already on the wire.
 *
 * `flush()` cancels the wait and writes immediately, resolving when the write
 * (and anything queued behind it) has settled. Call it on blur and from an
 * unmount path. The write is dispatched SYNCHRONOUSLY from `flush()`, before
 * the caller's teardown continues; only the resulting state update is dropped
 * once the host component is gone.
 *
 * WRITES NEVER OVERLAP. If a write is in flight when another value arrives, the
 * new value waits in a one-slot queue (newest wins) and goes out when the
 * current write settles. Two saves of the same field can therefore never land
 * out of order, which for a last-write-wins document is the whole ballgame.
 *
 * `state` is the save *result*, shaped for `SavedFlash` (identical union):
 *   idle    nothing written yet this session
 *   saving  a write is in flight
 *   saved   the last write landed
 *   error   the last write failed — see below
 *
 * `error` is the rejection the failing write threw, kept alongside `state` so a
 * caller can show the ROUTE'S OWN SENTENCE rather than only SavedFlash's
 * generic line — a refusal that explains itself ("your facilitator has already
 * reviewed this") is worth more than "couldn't save", and it is also how a
 * caller detects a status it must react to. Cleared by the next write that
 * succeeds, and by `reset()`.
 *
 * ERRORS ARE STICKY. Once `state` is "error" it stays "error" through every
 * subsequent attempt and is cleared ONLY by a write that succeeds — or by an
 * explicit `reset()`. Typing does not clear it, no timer clears it, and a retry
 * does not briefly flip it back to "saving": the member keeps reading "your
 * last change isn't stored" until their work is actually stored. That is
 * deliberate — an autosave failure is silent by nature, and the one signal it
 * has must not blink. `reset()` exists for the one case stickiness gets wrong:
 * the caller stored the value by ANOTHER path (an explicit Submit button that
 * posts directly), so the pending change is on the server after all and the
 * standing complaint is now a lie.
 *
 * ── WHAT SURVIVES A NAVIGATION (and what doesn't) ───────────────────────────
 * Pending work is dispatched on four occasions: the debounce timer firing,
 * `flush()`, React unmount, and the page being hidden or torn down —
 * `pagehide` plus `visibilitychange`→hidden, which between them cover the tab
 * closing, a hard navigation, an off-site link, and iOS backgrounding (where
 * `pagehide` may be the last event the page ever gets).
 *
 * The unmount and page-hide paths pass `{ keepalive: true }` to the caller's
 * `write`, which is expected to hand it to `fetch` — a keepalive request
 * outlives the document that started it, so it completes after the page is
 * gone. That is what makes those paths meaningful rather than decorative.
 *
 * Not guaranteed, deliberately stated:
 *   • Anything typed and not yet pushed (the caller's own state) is not the
 *     hook's to save.
 *   • A write ALREADY IN FLIGHT when the page hides was dispatched without
 *     keepalive (it was an ordinary debounce/blur write) and can still be
 *     aborted by the unload. The queued value behind it joins that running
 *     drain and inherits the same fate.
 *   • Keepalive bodies are capped at 64KB by the browser, across all in-flight
 *     keepalive requests. Callers writing anything larger get no such promise.
 *   • A hidden tab that is discarded outright, or a browser crash, takes
 *     whatever the timer was still holding.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * No retry loop, no offline queue, no leading-edge call, no per-value
 * de-duplication. `write` is expected to reject on failure; a resolved promise
 * means stored.
 */

/** Same four literals as `SavedFlash`'s `SaveState`, deliberately. */
export type DebouncedWriteState = "idle" | "saving" | "saved" | "error";

/**
 * The caller's write. `opts.keepalive` is true on the unmount / page-hide
 * paths and must be passed through to `fetch` for the request to outlive the
 * page — a writer that ignores it silently gives up the one guarantee those
 * paths exist for.
 */
export type DebouncedWriter<T> = (
  value: T,
  opts: { keepalive: boolean },
) => Promise<void>;

export type DebouncedWrite<T> = {
  /** Schedule a write of `value`; resets the wait, newest value wins. */
  push: (value: T) => void;
  /** Drop the scheduled write and the queued value. Never recalls a live one. */
  cancel: () => void;
  /** Write any pending value now; resolves once the queue has drained. */
  flush: () => Promise<void>;
  /** Back to "idle" with no error — for a caller that stored the value itself. */
  reset: () => void;
  state: DebouncedWriteState;
  /** The last failure, or null. Survives until a write succeeds or `reset()`. */
  error: Error | null;
};

/** The plan's autosave beat. */
export const DEFAULT_WRITE_DEBOUNCE_MS = 900;

export function useDebouncedWrite<T>(
  write: DebouncedWriter<T>,
  delayMs: number = DEFAULT_WRITE_DEBOUNCE_MS,
): DebouncedWrite<T> {
  const [state, setState] = useState<DebouncedWriteState>("idle");
  const [error, setError] = useState<Error | null>(null);

  // The latest `write` reachable from the drain loop without re-creating the
  // loop (and so without cancelling a scheduled push) when the caller passes a
  // fresh closure each render. Assigned in an effect, not during render, to
  // keep React's refs-during-render rule happy — DescriptionEditor's idiom.
  const writeRef = useRef(write);
  useEffect(() => {
    writeRef.current = write;
  }, [write]);

  const timerRef = useRef<number | null>(null);
  /**
   * The one-slot queue. Boxed so a legitimately falsy `T` (an empty string) is
   * still distinguishable from "nothing pending".
   */
  const pendingRef = useRef<{ value: T } | null>(null);
  const drainRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  /** Mirrors `state` for the loop, which must read it between awaits. */
  const stateRef = useRef<DebouncedWriteState>("idle");

  const set = useCallback((next: DebouncedWriteState) => {
    stateRef.current = next;
    // After unmount the write still matters; the indicator no longer does.
    if (mountedRef.current) setState(next);
  }, []);

  const setErr = useCallback((next: Error | null) => {
    if (mountedRef.current) setError(next);
  }, []);

  /** Clear the timer without touching the queued value. */
  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Drain the queue, one write at a time. Re-entrant calls join the running
   * drain rather than starting a second one — that is the no-overlap
   * guarantee, and it is also why `flush()` can simply await the result.
   *
   * `keepalive` describes THIS drain's dispatches. A caller that joins a drain
   * already running cannot upgrade it (the in-flight request is already on the
   * wire), which is the page-hide caveat spelled out in the module comment.
   */
  const drain = useCallback(
    (keepalive = false): Promise<void> => {
      const running = drainRef.current;
      if (running) return running;

      const run = (async () => {
        // Re-read the slot each pass: a push landing mid-write is picked up here
        // rather than starting a competing drain.
        while (pendingRef.current) {
          const { value } = pendingRef.current;
          pendingRef.current = null;
          if (stateRef.current !== "error") set("saving");
          try {
            await writeRef.current(value, { keepalive });
            setErr(null);
            set("saved");
          } catch (e) {
            setErr(e instanceof Error ? e : new Error(String(e)));
            set("error");
          }
        }
      })();

      drainRef.current = run;
      // The loop swallows write failures, so `run` only ever resolves.
      void run.finally(() => {
        if (drainRef.current === run) drainRef.current = null;
      });
      return run;
    },
    [set, setErr],
  );

  const push = useCallback(
    (value: T) => {
      pendingRef.current = { value };
      stopTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void drain();
      }, delayMs);
    },
    [delayMs, drain, stopTimer],
  );

  const cancel = useCallback(() => {
    stopTimer();
    pendingRef.current = null;
  }, [stopTimer]);

  const flushWith = useCallback(
    (keepalive: boolean): Promise<void> => {
      stopTimer();
      return drain(keepalive);
    },
    [drain, stopTimer],
  );

  const flush = useCallback(() => flushWith(false), [flushWith]);

  const reset = useCallback(() => {
    stateRef.current = "idle";
    if (mountedRef.current) {
      setState("idle");
      setError(null);
    }
  }, []);

  /**
   * The page going away is not an unmount: a hard navigation, a closed tab or
   * a backgrounded iOS browser tears the document down with React none the
   * wiser. `pagehide` is the reliable end-of-life event (`unload` is ignored by
   * modern back/forward caches) and `visibilitychange`→hidden is the one that
   * fires first when a tab is switched away from and may be the LAST one on
   * mobile. Both dispatch with keepalive; whichever runs second finds the queue
   * already empty and is a no-op.
   */
  useEffect(() => {
    const dispatch = () => {
      void flushWith(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") dispatch();
    };
    window.addEventListener("pagehide", dispatch);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", dispatch);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushWith]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Order matters: silence the indicator FIRST (the component is going),
      // then dispatch the pending write. `drain()` runs synchronously up to
      // its first await, so the request is on the wire before this cleanup
      // returns — and it goes out keepalive, because a soft nav is often
      // followed by a hard one before a normal request could land.
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      void drain(true);
    };
  }, [drain]);

  return { push, cancel, flush, reset, state, error };
}

export default useDebouncedWrite;
