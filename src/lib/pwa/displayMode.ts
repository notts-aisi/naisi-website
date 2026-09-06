/**
 * Is the site running as an installed app, and on what?
 *
 * The single source of truth for display-mode questions. Pure predicates
 * only; the React binding lives in src/hooks/useDisplayMode.ts, matching where
 * useBodyScrollLock and useInViewOnce already sit.
 *
 * All of these are safe to call during SSR: each returns the "browser tab"
 * answer when there is no window, which is the correct conservative default
 * (nothing should light up standalone-only behaviour on the server and then
 * have it disappear on hydration).
 */

/**
 * Non-standard iOS-only flag. Safari sets navigator.standalone on home-screen
 * web apps and has done since long before display-mode was supported, and
 * older iOS still needs it, so both are checked.
 */
type IosNavigator = Navigator & { standalone?: boolean };

/** Running in an installed app window rather than a browser tab. */
export function isStandaloneNow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // Chrome's Trusted Web Activity reports fullscreen or minimal-ui instead.
  if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  return (window.navigator as IosNavigator).standalone === true;
}

/**
 * Subscribe to standalone changes. In practice this fires approximately
 * never (a window does not usually change display mode mid-session), but
 * useSyncExternalStore needs a subscribe function and a matchMedia listener
 * is cheaper than polling.
 */
export function subscribeDisplayMode(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const queries = [
    window.matchMedia("(display-mode: standalone)"),
    window.matchMedia("(display-mode: fullscreen)"),
  ];
  queries.forEach((q) => q.addEventListener("change", onChange));
  return () => queries.forEach((q) => q.removeEventListener("change", onChange));
}

/** iOS or iPadOS, including iPads that report as Macs with a touchscreen. */
export function isIos(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports a Mac UA. A Mac with a touchscreen does not exist, so
  // maxTouchPoints disambiguates.
  return ua.includes("Macintosh") && window.navigator.maxTouchPoints > 1;
}

export type InstallPlatform = "ios" | "android" | "desktop";

/**
 * Which set of install instructions applies. Only meaningful when NOT already
 * standalone; callers should check isStandaloneNow() first.
 *
 * iOS is the one that needs prose, because Safari has no install prompt event
 * and the only route in is Share, then Add to Home Screen.
 */
export function getInstallPlatform(): InstallPlatform {
  if (isIos()) return "ios";
  if (typeof window !== "undefined" && /Android/.test(window.navigator.userAgent)) {
    return "android";
  }
  return "desktop";
}
