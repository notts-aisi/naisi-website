"use client";

import Link from "next/link";
import type { SiteNotice, SiteNoticeSurface } from "@/lib/siteNotice";
import { SITE_NOTICE_SURFACE_NAMES } from "@/lib/siteNotice";
import styles from "./SurfacePausedNotice.module.css";

/** "Today 19:34" / "2 Aug, 19:34" — compact ETA for inline copy. */
export function formatEta(date: Date): string {
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.toDateString() === new Date().toDateString();
  if (sameDay) return `${time} today`;
  return `${time} on ${date.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

/**
 * The structured inline explanation rendered next to a submit that a paused
 * surface has disabled: what is paused, where to read more (the /status
 * maintenance log), the ETA, and the reassurance that nothing typed is lost.
 * Deliberately does NOT repeat the banner's message — the banner is already
 * on screen saying it.
 */
export function SurfacePausedNotice({
  notice,
  surface,
}: {
  notice: SiteNotice;
  surface: SiteNoticeSurface;
}) {
  const eta = notice.endsAt ?? notice.expiresAt;
  return (
    <div className={styles.box} role="status">
      <p className={styles.lead}>
        {SITE_NOTICE_SURFACE_NAMES[surface]} are paused by an administrator while
        we work on an issue.
      </p>
      <p className={styles.detail}>
        See the <Link href="/status#log">maintenance log</Link> for details
        {eta !== null && (
          <>
            {" "}
            — estimated back by <strong>{formatEta(eta)}</strong>
          </>
        )}
        . Anything you&apos;ve entered stays on this page; it just can&apos;t be
        submitted until the pause lifts.
      </p>
    </div>
  );
}
