"use client";

/*
 * Remembering where a signed-in member was, so an installed app relaunch
 * can put them back there.
 *
 * iOS kills backgrounded home-screen apps unpredictably (no documented
 * threshold, no lifecycle event, no restoration API) and relaunches them at
 * the manifest's start_url, which is the marketing homepage. "Check the
 * calendar, answer a message, come back" landing on the hero is the single
 * most app-breaking behaviour the platform forces on us, and the only fix
 * is remembering the route ourselves.
 *
 * Only paths inside the authed area are recorded (the tracker mounts in the
 * (app) layout), which quietly encodes "signed-in members only": a public
 * visitor's relaunch lands on the homepage as it should, and a recorded
 * path implies the person was signed in when it was written. localStorage,
 * not sessionStorage, because surviving the process kill is the entire
 * point, and installed-app localStorage is exempt from ITP's seven-day cap.
 *
 * Only the pathname is recorded, never query or hash, so tokens and
 * one-shot state can never be replayed into a relaunch.
 */

const KEY = "naisi.lastRoute";

/** Ignore a stored route older than this: a week-old task board is no
 *  longer "where you were", it is just history. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function recordLastRoute(pathname: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ path: pathname, ts: Date.now() }));
  } catch {
    /* no storage, no restore; the relaunch just lands on the homepage */
  }
}

export function readLastRoute(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { path?: unknown; ts?: unknown };
    if (typeof parsed.path !== "string" || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > MAX_AGE_MS) return null;
    // Same open-redirect guard as everywhere else: same-origin path only.
    if (!parsed.path.startsWith("/") || parsed.path.startsWith("//")) return null;
    return parsed.path;
  } catch {
    return null;
  }
}
