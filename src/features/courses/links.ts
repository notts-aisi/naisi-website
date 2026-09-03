/**
 * THE ONE SPELLING of a run's week URL.
 *
 * Small enough to re-inline, which is exactly why it had been: the run home
 * held a local `weekHref` and the facilitator panel wrote the same template
 * literal out again, so a link two components apart could only stay in step by
 * luck. `encodeURIComponent` on the run id is the half that goes missing when
 * it is retyped, and a run id is a slug plus a random suffix rather than
 * anything guaranteed path-safe.
 *
 * Pure and client-safe: no imports, no clock, nothing server-only, so a server
 * page can build the same link as a client component.
 */
export function weekHref(runId: string, weekNumber: number): string {
  return `/learn/${encodeURIComponent(runId)}/weeks/${weekNumber}`;
}
