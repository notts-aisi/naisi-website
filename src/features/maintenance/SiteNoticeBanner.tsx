"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSiteNotice } from "./useSiteNotice";
import { useOnline } from "@/lib/network/useOnline";
import styles from "./SiteNoticeBanner.module.css";

/**
 * The site-wide maintenance banner, mounted ONCE in the root layout so it
 * covers every route — marketing, auth, the authed app, and the three routes
 * outside all route groups (/verify-email/[tokenId], /re-consent,
 * /collaborator — the first being the incident surface).
 *
 * Renders PLAIN TEXT ONLY. The doc is world-readable and this sits on every
 * page: no dangerouslySetInnerHTML, no markdown, ever. The only link is a
 * separate anchor whose href the normaliser restricts to https://.
 *
 * Layout contract: the banner is in normal flow at the top of <body> and
 * publishes its measured height as `--site-notice-height` on <html>. The two
 * viewport-pinned layouts subtract it — the (auth) shell (100dvh with body
 * scroll locked by AuthBodyLock, so an uncompensated banner would push the
 * mobile submit bar off-screen with no way to scroll to it) and AppShell's
 * fixed sidebar. With no notice the property is absent and their `0px`
 * fallbacks make both layouts byte-identical to before this feature.
 *
 * The OFFLINE strip renders inside the same measured wrapper, deliberately.
 * It must participate in the `--site-notice-height` contract (a banner the
 * pinned layouts do not subtract would overlap the sidebar and the auth
 * shell), and a second component publishing the same custom property would
 * hand the contract two owners that can fight. One wrapper, one observer,
 * one property. The maintenance-notice model itself is NOT extended for
 * this — "this device has no network" is not a maintenance episode, and
 * folding it into the notice doc would corrupt the
 * `bannerVisible = active || anyPaused` invariant.
 *
 * Division of labour with the service worker's /offline.html: that page is
 * for a NAVIGATION that failed offline; this strip is for a page already
 * open that loses its connection. Keep their copy aligned when editing
 * either.
 */
export function SiteNoticeBanner() {
  const notice = useSiteNotice();
  const ref = useRef<HTMLDivElement | null>(null);
  // Lazy initial read is safe pre-hydration: the banner renders null until
  // the first snapshot arrives (client-side, post-hydration) regardless.
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem("naisi.siteNotice.dismissed");
    } catch {
      // Storage unavailable (private mode etc) — banner just stays visible.
      return null;
    }
  });

  // Identity of the current notice for per-session dismissal: a new write or
  // any change in copy/level/pauses resurfaces a previously dismissed info
  // banner. The level+pauses fingerprint matters for break-glass flips, which
  // don't touch updatedAt and may reuse the same copy.
  const noticeKey = notice.bannerVisible
    ? `${notice.updatedAt?.toISOString() ?? ""}|${notice.level}|${JSON.stringify(notice.paused)}|${notice.bannerMessage}`
    : null;

  const visible =
    notice.bannerVisible &&
    !(notice.level === "info" && noticeKey !== null && noticeKey === dismissedKey);

  /*
   * false only when the device definitely has no network route. Deliberately
   * NOT dismissible: unlike an info notice, offline is a live state, not an
   * announcement, and it clears itself the moment the connection returns.
   */
  const online = useOnline();
  const anyVisible = visible || !online;

  useEffect(() => {
    if (!anyVisible) return;
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--site-notice-height", `${el.offsetHeight}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--site-notice-height");
    };
  }, [anyVisible]);

  if (!anyVisible) return null;

  const dismiss = () => {
    setDismissedKey(noticeKey);
    try {
      window.sessionStorage.setItem("naisi.siteNotice.dismissed", noticeKey ?? "");
    } catch {
      // Best-effort; in-memory dismissal still applies for this mount.
    }
  };

  return (
    <div ref={ref}>
      {visible && (
        <div
          className={`${styles.banner} ${styles[notice.level]}`}
          role="status"
          aria-live="polite"
        >
          <p className={styles.message}>{notice.bannerMessage}</p>
          {/* Lands on /status with the current notice's detail popup open. */}
          <Link className={styles.link} href="/status?open=current#log">
            Details
          </Link>
          {notice.level === "info" && (
            <button
              type="button"
              className={styles.dismiss}
              onClick={dismiss}
              aria-label="Dismiss notice"
            >
              ×
            </button>
          )}
        </div>
      )}
      {!online && (
        <div
          className={`${styles.banner} ${styles.offline}`}
          role="status"
          aria-live="polite"
        >
          {/* Copy aligned with public/offline.html (via its template); that
              page covers a failed navigation, this strip covers a page that
              is already open. */}
          <p className={styles.message}>
            You are offline. Nothing will save until the connection returns.
          </p>
        </div>
      )}
    </div>
  );
}
