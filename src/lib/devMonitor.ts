"use client";

/**
 * Lightweight client-side console monitor for debugging hangs in the
 * sign-in handoff and navigation lifecycle. Logs are tagged with
 * `[monitor +<ms-since-page-load>]` and only emit when the
 * `NEXT_PUBLIC_DEBUG_MONITOR` env var is set to "true" — set it on the
 * dev App Hosting backend's environment variables (Firebase console),
 * NOT on prod, so the monitor is dev-only without any code branching.
 *
 * Why a custom logger instead of plain `console.log` everywhere:
 * - Single tag makes filtering the devtools console trivial
 *   (filter on "[monitor"). Without it, the events realtime listener's
 *   `[rt-debug]` instrumentation and any future probes would intermix.
 * - Relative timestamps (ms since page load) make "this fired right
 *   after that" obvious without manually subtracting wall-clock times.
 * - The watchdog helper makes "X never happened in N seconds"
 *   detectable from the logs — critical for the staying-on-login
 *   symptom where the absence of a navigation is the signal.
 *
 * Companion to (but independent of) the parked `[rt-debug]`
 * instrumentation on `fix/events-realtime-listener` — different scope
 * (auth + nav, not events listeners), different tag, can coexist.
 */

const ENABLED =
  typeof process !== "undefined"
  && process.env.NEXT_PUBLIC_DEBUG_MONITOR === "true";

// Anchored at module load (one per page load). Using performance.now()
// rather than Date.now() so the deltas survive across system-clock jumps
// (NTP corrections, suspend/resume) and have sub-millisecond resolution.
const ORIGIN =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;

function stamp(): string {
  if (typeof performance === "undefined") return "+?ms";
  const ms = Math.round(performance.now() - ORIGIN);
  return `+${ms}ms`;
}

export function isMonitorEnabled(): boolean {
  return ENABLED;
}

export function mark(label: string, extra?: unknown): void {
  if (!ENABLED) return;
  if (extra === undefined) {
    console.log(`[monitor ${stamp()}] ${label}`);
  } else {
    console.log(`[monitor ${stamp()}] ${label}`, extra);
  }
}

export function warn(label: string, extra?: unknown): void {
  if (!ENABLED) return;
  if (extra === undefined) {
    console.warn(`[monitor ${stamp()}] ${label}`);
  } else {
    console.warn(`[monitor ${stamp()}] ${label}`, extra);
  }
}

/**
 * Start a one-shot watchdog. If the returned `clear()` isn't called within
 * `timeoutMs`, emits a warning. Use for "this thing should happen soon":
 * sign-in popup resolving, the user-doc snapshot's first fire, the
 * post-signin navigation actually landing somewhere other than /login.
 *
 * Returns a no-op cleanup function when the monitor is disabled, so the
 * call sites stay symmetric (always call clear() in a finally / on the
 * happy path).
 */
export function watchdog(label: string, timeoutMs: number): () => void {
  if (!ENABLED) return () => {};
  const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
  const t = setTimeout(() => {
    console.warn(
      `[monitor ${stamp()}] WATCHDOG "${label}" not cleared in ${timeoutMs}ms`,
    );
  }, timeoutMs);
  return () => {
    clearTimeout(t);
    if (ENABLED && typeof performance !== "undefined") {
      const elapsed = Math.round(performance.now() - startedAt);
      console.log(`[monitor ${stamp()}] cleared "${label}" after ${elapsed}ms`);
    }
  };
}

let instanceCounter = 0;

/**
 * Make a per-instance logger so multiple AuthProviders / AppShells /
 * snapshot listeners on the same page don't smear together. The returned
 * `mark`/`warn` prefix every line with `<name>#<n>`.
 */
export function instance(name: string): {
  id: string;
  mark: (label: string, extra?: unknown) => void;
  warn: (label: string, extra?: unknown) => void;
} {
  const id = `${name}#${++instanceCounter}`;
  return {
    id,
    mark: (label, extra) => mark(`${id} ${label}`, extra),
    warn: (label, extra) => warn(`${id} ${label}`, extra),
  };
}
