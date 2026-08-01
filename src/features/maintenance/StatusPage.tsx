"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useSiteNoticeState } from "./useSiteNotice";
import { formatEta } from "./SurfacePausedNotice";
import {
  MAINTENANCE_LOG_LIMIT,
  MAINTENANCE_LOG_PATH,
  SITE_NOTICE_SURFACES,
  SITE_NOTICE_SURFACE_NAMES,
  normaliseLogEntry,
  type MaintenanceLogEntry,
  type SiteNoticeLevel,
} from "@/lib/siteNotice";
import styles from "./StatusPage.module.css";

/**
 * Public availability dashboard + maintenance log at /status. Lights derive
 * from the SAME live notice doc the banner streams (truthful even for
 * break-glass console flips); the log lists the episodes the admin route has
 * recorded. Everything fails open: unreadable doc → all green, unreadable log
 * → empty history — this page must never look worse than reality.
 */

const LEVEL_CLASS: Record<SiteNoticeLevel, string> = {
  info: styles.levelInfo,
  warn: styles.levelWarn,
  critical: styles.levelCritical,
};

function formatStamp(date: Date): string {
  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function StatusPage() {
  const { notice: live, connection } = useSiteNoticeState();
  const [entries, setEntries] = useState<MaintenanceLogEntry[]>([]);
  const [logState, setLogState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const db = getClientDb();
      const q = query(
        collection(db, MAINTENANCE_LOG_PATH.collection),
        orderBy("startedAt", "desc"),
        limit(MAINTENANCE_LOG_LIMIT),
      );
      unsubscribe = onSnapshot(
        q,
        (snap) => {
          const now = new Date();
          setEntries(
            snap.docs
              .map((doc) => normaliseLogEntry(doc.id, doc.data(), now))
              .filter((entry): entry is MaintenanceLogEntry => entry !== null),
          );
          setLogState("ready");
        },
        () => {
          // Fail open — no history beats fabricated history.
          setEntries([]);
          setLogState("error");
        },
      );
    } catch {
      queueMicrotask(() => setLogState("error"));
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Only the newest entry may present as ongoing, and only while the live
  // notice actually shows — a log entry must never claim an outage the
  // banner doesn't.
  const ongoingId =
    live.bannerVisible && entries[0]?.ongoing ? entries[0].id : null;

  // Timeline reads oldest → newest, left to right.
  const timeline = useMemo(() => [...entries].reverse(), [entries]);
  const eta = live.endsAt ?? live.expiresAt;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Service status</h1>
        <p className={styles.subtitle}>
          Live availability of NAISI services, straight from the same feed the
          site-wide banner uses.
        </p>
      </header>

      {connection === "live" && live.bannerVisible && (
        <div className={`${styles.noticeCard} ${LEVEL_CLASS[live.level]}`}>
          <p className={styles.noticeMessage}>{live.bannerMessage}</p>
          <p className={styles.noticeMeta}>
            {eta !== null
              ? `Estimated resolution by ${formatEta(eta)}.`
              : "No estimated resolution time yet."}
            {live.linkUrl !== null && (
              <>
                {" "}
                <a href={live.linkUrl} target="_blank" rel="noopener noreferrer">
                  More info
                </a>
              </>
            )}
          </p>
        </div>
      )}

      <section aria-labelledby="availability-heading">
        <h2 id="availability-heading" className={styles.sectionTitle}>
          Availability
        </h2>
        {connection === "loading" ? (
          // Never show a light before the feed has answered: a premature
          // green is an "Operational" claim nobody has actually made.
          <div className={styles.loadingRow} role="status">
            <span className={styles.spinner} aria-hidden />
            Checking current status…
          </div>
        ) : (
          <>
            <ul className={styles.serviceList}>
              {SITE_NOTICE_SURFACES.map((surface) => {
                const unknown = connection === "error";
                const paused = live.paused[surface];
                const lightClass = unknown
                  ? styles.lightUnknown
                  : !paused
                    ? styles.lightGreen
                    : live.level === "critical"
                      ? styles.lightRed
                      : styles.lightAmber;
                return (
                  <li key={surface} className={styles.serviceRow}>
                    <span className={`${styles.light} ${lightClass}`} aria-hidden />
                    <span className={styles.serviceName}>
                      {SITE_NOTICE_SURFACE_NAMES[surface]}
                    </span>
                    <span
                      className={`${styles.serviceState} ${
                        unknown
                          ? styles.stateUnknown
                          : paused
                            ? styles.statePaused
                            : styles.stateOk
                      }`}
                    >
                      {unknown ? "Unknown" : paused ? "Paused" : "Operational"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {connection === "error" && (
              <p className={styles.smallPrint}>
                We can&apos;t reach the status feed right now — these lights may
                be out of date. Check your connection and try again.
              </p>
            )}
          </>
        )}
        <p className={styles.smallPrint}>
          Sign-in and password reset run directly against Firebase and are
          always reachable from here even during app maintenance.
        </p>
      </section>

      <section id="log" aria-labelledby="log-heading" className={styles.logSection}>
        <h2 id="log-heading" className={styles.sectionTitle}>
          Maintenance log
        </h2>

        {logState === "loading" ? (
          <div className={styles.loadingRow} role="status">
            <span className={styles.spinner} aria-hidden />
            Loading history…
          </div>
        ) : logState === "error" ? (
          <p className={styles.smallPrint}>
            Couldn&apos;t load the maintenance log right now.
          </p>
        ) : entries.length === 0 ? (
          <p className={styles.smallPrint}>
            No maintenance events on record. If a banner is showing without an
            entry here, it was raised through the emergency path — the banner is
            always the authority.
          </p>
        ) : (
          <>
            <div className={styles.timeline} role="list" aria-label="Maintenance events">
              <span className={styles.timelineTrack} aria-hidden />
              {timeline.map((entry) => (
                <a
                  key={entry.id}
                  role="listitem"
                  href={`#log-${entry.id}`}
                  title={`${formatStamp(entry.startedAt)} — ${entry.message || "maintenance"}`}
                  className={`${styles.timelineDot} ${LEVEL_CLASS[entry.level]} ${
                    entry.id === ongoingId ? styles.dotOngoing : ""
                  }`}
                >
                  <span className={styles.visuallyHidden}>
                    {formatStamp(entry.startedAt)}
                  </span>
                </a>
              ))}
            </div>

            <ul className={styles.entryList}>
              {entries.map((entry) => {
                const isOngoing = entry.id === ongoingId;
                const endedAt = entry.clearedAt ?? entry.endsAt;
                const affected = SITE_NOTICE_SURFACES.filter((s) => entry.paused[s]);
                return (
                  <li key={entry.id} id={`log-${entry.id}`} className={styles.entry}>
                    <div className={styles.entryHead}>
                      <span className={`${styles.levelChip} ${LEVEL_CLASS[entry.level]}`}>
                        {entry.level}
                      </span>
                      <span className={styles.entryWhen}>
                        {formatStamp(entry.startedAt)}
                        {isOngoing ? (
                          <span className={styles.ongoingBadge}> ongoing</span>
                        ) : (
                          endedAt !== null && ` → ${formatStamp(endedAt)}`
                        )}
                      </span>
                    </div>
                    <p className={styles.entryMessage}>
                      {entry.message || "Scheduled maintenance."}
                    </p>
                    {affected.length > 0 && (
                      <p className={styles.entryMeta}>
                        Paused: {affected.map((s) => SITE_NOTICE_SURFACE_NAMES[s]).join(", ")}
                      </p>
                    )}
                    {entry.linkUrl !== null && (
                      <p className={styles.entryMeta}>
                        <a href={entry.linkUrl} target="_blank" rel="noopener noreferrer">
                          More info
                        </a>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
