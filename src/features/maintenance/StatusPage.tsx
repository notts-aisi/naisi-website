"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
 * recorded, each expandable into a popup (the banner's Details link arrives
 * with ?open=current, which opens the ongoing episode's popup directly).
 *
 * Honesty rules: nothing renders as green before the feed has answered
 * (loading spinner instead), an erroring feed shows grey "Unknown", and all
 * log content is PLAIN TEXT — the docs are world-readable, so no HTML or
 * markdown may ever be rendered from them.
 */

const LEVEL_CLASS: Record<SiteNoticeLevel, string> = {
  info: styles.levelInfo,
  warn: styles.levelWarn,
  critical: styles.levelCritical,
};

/** Entries longer than this get clamped with a fade + "more info" popup. */
const CLAMP_THRESHOLD = 180;

function formatStamp(date: Date): string {
  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function entryNeedsPopup(entry: MaintenanceLogEntry): boolean {
  return entry.details !== "" || entry.message.length > CLAMP_THRESHOLD;
}

function EntryStatusBadge({ ongoing }: { ongoing: boolean }) {
  return (
    <span
      className={`${styles.stateBadge} ${ongoing ? styles.stateBadgeOngoing : styles.stateBadgeDone}`}
    >
      {ongoing ? "In progress" : "Complete"}
    </span>
  );
}

function EntryModal({
  entry,
  ongoing,
  onClose,
}: {
  entry: MaintenanceLogEntry;
  ongoing: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const endedAt = entry.clearedAt ?? entry.endsAt;
  const affected = SITE_NOTICE_SURFACES.filter((s) => entry.paused[s]);

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Maintenance notice details"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={styles.modalClose}
          onClick={onClose}
          aria-label="Back to the status page"
          autoFocus
        >
          ×
        </button>
        <div className={styles.entryHead}>
          <span className={`${styles.levelChip} ${LEVEL_CLASS[entry.level]}`}>
            {entry.level}
          </span>
          <EntryStatusBadge ongoing={ongoing} />
        </div>
        <p className={styles.modalWhen}>
          Started {formatStamp(entry.startedAt)}
          {ongoing
            ? entry.endsAt !== null
              ? ` · provisional ETA ${formatEta(entry.endsAt)}`
              : " · no ETA yet"
            : endedAt !== null
              ? ` · resolved ${formatStamp(endedAt)}`
              : ""}
        </p>
        <p className={styles.modalMessage}>{entry.message || "Maintenance notice."}</p>
        {entry.details !== "" && (
          <p className={styles.modalDetails}>{entry.details}</p>
        )}
        {affected.length > 0 && (
          <p className={styles.entryMeta}>
            Paused during this work:{" "}
            {affected.map((s) => SITE_NOTICE_SURFACE_NAMES[s]).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

export default function StatusPage() {
  const { notice: live, connection } = useSiteNoticeState();
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<MaintenanceLogEntry[]>([]);
  const [logState, setLogState] = useState<"loading" | "ready" | "error">("loading");
  // null = closed; "pending-auto" = waiting for the log to answer a
  // ?open=current deep link (resolved render-phase, per the Dropdown pattern).
  const [openEntryId, setOpenEntryId] = useState<string | null | "pending-auto">(
    searchParams.get("open") === "current" ? "pending-auto" : null,
  );

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    // Same honesty rule as the notice feed: cache-only data never claims
    // "ready", and a quiet offline client degrades to error after 4s.
    const staleTimer = setTimeout(() => {
      setLogState((current) => (current === "ready" ? current : "error"));
    }, 4000);
    try {
      const db = getClientDb();
      const q = query(
        collection(db, MAINTENANCE_LOG_PATH.collection),
        orderBy("startedAt", "desc"),
        limit(MAINTENANCE_LOG_LIMIT),
      );
      unsubscribe = onSnapshot(
        q,
        { includeMetadataChanges: true },
        (snap) => {
          const now = new Date();
          setEntries(
            snap.docs
              .map((doc) => normaliseLogEntry(doc.id, doc.data(), now))
              .filter((entry): entry is MaintenanceLogEntry => entry !== null),
          );
          if (!snap.metadata.fromCache) setLogState("ready");
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
      clearTimeout(staleTimer);
      unsubscribe?.();
    };
  }, []);

  // Live badges/countdowns: the current episode is identified POSITIVELY by
  // the live doc's logId — never positionally — and only while the notice
  // actually shows. A break-glass notice with no entry means no entry claims
  // ongoing (the log's own caveat covers that); a log entry must never claim
  // an outage the banner doesn't.
  const ongoingId =
    connection === "live" &&
    live.bannerVisible &&
    live.logId !== null &&
    entries.some((entry) => entry.id === live.logId && entry.ongoing)
      ? live.logId
      : null;

  // Resolve a ?open=current deep link once the log has answered.
  if (openEntryId === "pending-auto" && logState !== "loading") {
    setOpenEntryId(logState === "ready" && ongoingId !== null ? ongoingId : null);
  }

  const openEntry =
    typeof openEntryId === "string" && openEntryId !== "pending-auto"
      ? entries.find((entry) => entry.id === openEntryId) ?? null
      : null;

  function closeModal() {
    setOpenEntryId(null);
    // Drop the ?open=current param so a refresh doesn't re-open the popup.
    if (searchParams.get("open") !== null) {
      window.history.replaceState(null, "", "/status#log");
    }
  }

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
              {timeline.map((entry) => {
                const isOngoing = entry.id === ongoingId;
                return (
                  <a
                    key={entry.id}
                    role="listitem"
                    href={`#log-${entry.id}`}
                    title={`${formatStamp(entry.startedAt)} — ${entry.message || "maintenance notice"}`}
                    className={`${styles.timelineDot} ${
                      isOngoing
                        ? `${LEVEL_CLASS[entry.level]} ${styles.dotOngoing}`
                        : styles.dotResolved
                    }`}
                  >
                    <span className={styles.visuallyHidden}>
                      {formatStamp(entry.startedAt)}
                    </span>
                  </a>
                );
              })}
            </div>

            <ul className={styles.entryList}>
              {entries.map((entry) => {
                const isOngoing = entry.id === ongoingId;
                const endedAt = entry.clearedAt ?? entry.endsAt;
                const affected = SITE_NOTICE_SURFACES.filter((s) => entry.paused[s]);
                const needsPopup = entryNeedsPopup(entry);
                return (
                  <li key={entry.id} id={`log-${entry.id}`} className={styles.entry}>
                    <div className={styles.entryHead}>
                      <span className={`${styles.levelChip} ${LEVEL_CLASS[entry.level]}`}>
                        {entry.level}
                      </span>
                      <EntryStatusBadge ongoing={isOngoing} />
                      <span className={styles.entryWhen}>
                        {formatStamp(entry.startedAt)}
                        {isOngoing
                          ? entry.endsAt !== null &&
                            ` · ETA ${formatEta(entry.endsAt)}`
                          : endedAt !== null && ` → ${formatStamp(endedAt)}`}
                      </span>
                    </div>
                    <div
                      className={`${styles.entryBody} ${needsPopup ? styles.entryBodyClamped : ""}`}
                    >
                      {/* Neutral fallback — "scheduled" would misdescribe an
                          unplanned incident logged without copy. */}
                      <p className={styles.entryMessage}>
                        {entry.message || "Maintenance notice."}
                      </p>
                      {entry.details !== "" && (
                        <p className={styles.entryDetailsPreview}>{entry.details}</p>
                      )}
                    </div>
                    {affected.length > 0 && (
                      <p className={styles.entryMeta}>
                        Paused: {affected.map((s) => SITE_NOTICE_SURFACE_NAMES[s]).join(", ")}
                      </p>
                    )}
                    {needsPopup && (
                      <button
                        type="button"
                        className={styles.moreButton}
                        onClick={() => setOpenEntryId(entry.id)}
                      >
                        Click for more info
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {openEntry !== null && (
        <EntryModal
          entry={openEntry}
          ongoing={openEntry.id === ongoingId}
          onClose={closeModal}
        />
      )}
    </div>
  );
}
