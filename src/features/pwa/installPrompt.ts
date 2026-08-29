"use client";

/*
 * Shared plumbing for the install affordances (the drawer row and the
 * dashboard card).
 *
 * Chrome fires `beforeinstallprompt` once, early, and only hands the
 * deferred prompt to whoever was listening at that moment. Components mount
 * too late, so a module-level listener captures it the moment this module
 * is first imported (the root layout imports StandaloneFlag from the same
 * feature folder, so in practice this is early in hydration). Subscribers
 * are notified when it arrives, since it can land before or after a
 * component mounts.
 *
 * On iOS this event does not exist at all; the affordances show
 * "Share, then Add to Home Screen" instructions instead, keyed off
 * getInstallPlatform().
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  // Fired by the browser after a successful install, on every platform that
  // fires beforeinstallprompt. Clearing hides the affordances immediately.
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    listeners.forEach((l) => l());
  });
}

export function subscribeInstallPrompt(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function hasDeferredPrompt(): boolean {
  return deferredPrompt !== null;
}

/** Shows Chrome's install dialog. Resolves true if the user accepted. */
export async function triggerInstall(): Promise<boolean> {
  const p = deferredPrompt;
  if (!p) return false;
  await p.prompt();
  const choice = await p.userChoice;
  // The event is single-use regardless of outcome.
  deferredPrompt = null;
  listeners.forEach((l) => l());
  return choice.outcome === "accepted";
}

/*
 * Dismissal for the dashboard card. One localStorage key, no timers, no
 * re-show ladder. localStorage rather than a cookie for the same PECR
 * reasoning recorded for naisi.sidebar.collapsed.
 */
const DISMISS_KEY = "naisi.installCard.dismissed";

export function installCardDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return true; /* no storage, no card: it would nag on every visit */
  }
}

export function dismissInstallCard(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* in-memory dismissal only for this page */
  }
}
