"use client";

import Link from "next/link";
import { type MouseEvent, type ReactNode } from "react";
import { usePublicTransition } from "./PublicMain";

type Props = {
  href: string;
  className?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** Wait this many ms after the click before starting the page
   *  fade-out. Used by drawer Sign-in links so the drawer's own close
   *  animation gets to play out fully before the route transition. */
  delayMs?: number;
  "aria-label"?: string;
};

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

/** Inject the Google Identity Services script into the document head if
 *  it isn't already there. Called when a user clicks Sign in / Join us
 *  so the script downloads + executes during the homepage fade-out;
 *  by the time /login mounts (~320ms later) `window.google.accounts.id`
 *  is already available and the button renders without a visible
 *  loading flicker. Idempotent. */
function preloadGoogleIdentityServices() {
  if (typeof window === "undefined") return;
  if (window.google?.accounts?.id) return;
  if (document.querySelector(`script[src="${GIS_SCRIPT_URL}"]`)) return;
  const s = document.createElement("script");
  s.src = GIS_SCRIPT_URL;
  s.async = true;
  document.head.appendChild(s);
}

const AUTH_HREFS = new Set(["/login", "/register"]);
/** Destinations inside the authed (app) shell. When the public layout
 *  navigates to one of these, mirror what login/register do on sign-in
 *  success: set a sessionStorage flag that AppShell reads on mount to
 *  apply its `.entering` fade-in (opacity 0→1 + translateX(18px)→0
 *  over 620ms with a 280ms delay). Without this, e.g. Dashboard from
 *  the public homepage hard-cuts into the app shell, which reads as
 *  jarring against the smooth header-lift + body-fade-out exit. */
const APP_HREFS = new Set(["/dashboard", "/pending-approval"]);

/** Sets the same flag login/register use post-sign-in. AppShell
 *  consumes + clears it on mount. sessionStorage can be unavailable
 *  (private-mode iframe, etc.); the entering fade is a nice-to-have,
 *  not load-bearing, so silently skip. */
function markEnteringAppShell() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem("naisi:from-signin", "1");
  } catch {
    // ignore — fade-in falls back to a jump cut
  }
}

/**
 * Wraps `next/link` so clicking it on a public page first fades the
 * page out (via the `PublicMain` context) before router.push fires.
 * Falls back to normal Link behavior if the page isn't a PublicMain
 * descendant. Respects modifier clicks (cmd/ctrl/shift) for
 * open-in-new-tab.
 *
 * Also preloads the GIS script when navigating to an auth route so the
 * Google sign-in button doesn't flicker during the swipe-in.
 */
export default function TransitionLink({
  href,
  className,
  children,
  onClick,
  delayMs,
  ...rest
}: Props) {
  const ctx = usePublicTransition();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    // Preload GIS unconditionally for auth-destined links, even when
    // there's no PublicMain context (e.g. nav from a non-public page).
    // The fade-out is a bonus; the preload is the load-time benefit.
    if (AUTH_HREFS.has(href)) {
      preloadGoogleIdentityServices();
    }
    // Mark app-area navigation so AppShell fades in on mount instead
    // of jump-cutting. Same flag the login/register pages set on
    // sign-in success — semantic re-use is intentional (both cases
    // share "public surface → app shell, please fade").
    if (APP_HREFS.has(href)) {
      markEnteringAppShell();
    }
    if (!ctx) return;
    if (ctx.exiting) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (delayMs && delayMs > 0) {
      setTimeout(() => ctx.startExitTo(href), delayMs);
    } else {
      ctx.startExitTo(href);
    }
  };

  return (
    <Link href={href} className={className} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
}
