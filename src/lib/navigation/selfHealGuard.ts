"use client";

/**
 * One-shot guard for the passive self-heal hard navigation.
 *
 * The self-heal effect on /login re-mints a session cookie and then navigates
 * to the destination. That navigation has to be a full document load (see
 * hardNavigate.ts) — but a document load also RESETS `handledNavRef`, which is
 * the only thing stopping the effect from running again.
 *
 * So if the mint returns 200 but the cookie never sticks — an edge stripping
 * Set-Cookie, a `secure` mismatch, Safari ITP — an unguarded hard navigation
 * loops forever:
 *
 *     /dashboard -> 307 /login -> self-heal -> mint -> hard nav -> repeat
 *
 * The poisoned route cache this fix removes was accidentally preventing that
 * by wedging instead. Trading a wedge for an infinite reload loop would be a
 * worse bug, so the hard nav is claimed through here first.
 *
 * Fails OPEN: a browser without sessionStorage still self-heals, it just
 * loses the loop protection.
 */
const KEY = "naisi:selfheal-at";
const WINDOW_MS = 15_000;

/** True if a self-heal hard navigation is allowed right now, claiming it. */
export function claimSelfHealAttempt(): boolean {
  try {
    const prev = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Number.isFinite(prev) && prev > 0 && Date.now() - prev < WINDOW_MS) {
      return false;
    }
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable — fail open */
  }
  return true;
}

/** Called once we're provably inside the app shell: the heal worked. */
export function clearSelfHealAttempt(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/*
 * The stale-session heal (SessionSanityGuard) gets its OWN key rather than
 * sharing the one above, for two reasons:
 *
 *   1. AppShell clears `naisi:selfheal-at` unconditionally on mount, on the
 *      grounds that reaching the shell proves the forward heal worked. The
 *      stale-session heal fires FROM inside the shell, so sharing the key
 *      would hand it a guard that AppShell wipes moments later, leaving it
 *      with no loop protection at all.
 *   2. The two fire on mutually exclusive states (cookie missing with a live
 *      Firebase user, versus cookie present with no Firebase user), so they
 *      can never ping-pong. A shared key would only create a false positive:
 *      a legitimate sign-out followed by a sign-in inside 15 seconds would
 *      find the window already claimed.
 */
const STALE_SESSION_KEY = "naisi:stale-session-at";

/** True if a stale-session repair is allowed right now, claiming it. */
export function claimStaleSessionRepair(): boolean {
  try {
    const prev = Number(sessionStorage.getItem(STALE_SESSION_KEY) ?? 0);
    if (Number.isFinite(prev) && prev > 0 && Date.now() - prev < WINDOW_MS) {
      return false;
    }
    sessionStorage.setItem(STALE_SESSION_KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable — fail open, same as the forward heal */
  }
  return true;
}
