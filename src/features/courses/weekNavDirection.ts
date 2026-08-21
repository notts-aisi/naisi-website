/**
 * One-shot handoff of week-to-week travel direction, consumed by the next
 * week page's `PageEnter` (plan: "Placement map — Week page").
 *
 * A module-scoped slot rather than state/context/URL on purpose: the setter
 * runs in the OLD page's click handler and the reader runs in the NEW page's
 * first render — no shared React tree survives that hop, and a query param
 * would leak choreography into shareable URLs and history entries.
 *
 * Freshness-bounded so it can only describe the navigation that just
 * happened: back/forward buttons and deep links never call the setter, so a
 * stale value (e.g. a cmd-click that opened a new tab and never consumed it)
 * must not misdirect a later, unrelated entrance. Anything older than the
 * window reads as null and the page falls back to the default "up" rise.
 */

export type WeekNavDirection = "left" | "right";

/** A click-to-mount hop is tens of ms; 3s is generous without going stale. */
const FRESH_MS = 3000;

let pending: { dir: WeekNavDirection; at: number } | null = null;

/** Call in the nav handler, before the router navigates. */
export function setWeekNavDirection(dir: WeekNavDirection): void {
  pending = { dir, at: Date.now() };
}

/**
 * Read without clearing — PURE, so it is safe in a render-phase initialiser
 * (StrictMode's double render must get the same answer twice). The consumer
 * clears explicitly from a mount effect via `clearWeekNavDirection`.
 */
export function peekWeekNavDirection(): WeekNavDirection | null {
  if (!pending || Date.now() - pending.at > FRESH_MS) return null;
  return pending.dir;
}

export function clearWeekNavDirection(): void {
  pending = null;
}
