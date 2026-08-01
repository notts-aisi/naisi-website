"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  DEFAULT_SITE_NOTICE,
  SITE_NOTICE_PATH,
  normaliseSiteNotice,
  type SiteNotice,
} from "@/lib/siteNotice";

/**
 * "loading" until the first snapshot answers, then "live"; "error" when the
 * listener fails (offline, permission-denied). The banner ignores this —
 * unknown and error both render nothing there (fail-open). Surfaces that make
 * AFFIRMATIVE claims (the /status lights, the panel's live section) must not:
 * a green "Operational" shown before the feed has answered is a lie in the
 * optimistic direction, so they render loading/unknown states instead.
 */
export type SiteNoticeConnection = "loading" | "live" | "error";

/**
 * Live subscription to `publicConfig/siteNotice`. Firestore multiplexes the
 * doc listen onto the connection AuthProvider already holds, so extra
 * subscribers cost no extra bundle and no extra channel.
 *
 * FAIL-OPEN: any listener error (offline, permission-denied, a rules deploy
 * in flight) and any normalisation surprise resolves to DEFAULT_SITE_NOTICE —
 * notice off. Same shape as the useAdminLock error callback.
 */
export function useSiteNoticeState(): {
  notice: SiteNotice;
  connection: SiteNoticeConnection;
} {
  const [raw, setRaw] = useState<unknown>(null);
  const [connection, setConnection] = useState<SiteNoticeConnection>("loading");
  // Bumped when `expiresAt` passes so an already-open tab re-evaluates the
  // read-time expiry without needing a fresh snapshot from the server.
  const [expiryTick, setExpiryTick] = useState(0);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    // If nothing server-confirmed arrives promptly (offline device serving
    // only its Firestore cache never errors — it just stays quiet), degrade
    // to "error" so status surfaces say "Unknown" instead of spinning
    // forever; a later live snapshot upgrades it back.
    const staleTimer = setTimeout(() => {
      setConnection((current) => (current === "live" ? current : "error"));
    }, 4000);
    try {
      const db = getClientDb();
      const ref = doc(db, SITE_NOTICE_PATH.collection, SITE_NOTICE_PATH.doc);
      unsubscribe = onSnapshot(
        ref,
        { includeMetadataChanges: true },
        (snap) => {
          setRaw(snap.exists() ? snap.data() : null);
          // A cache-served snapshot is NOT confirmation: an offline client
          // replaying stale cache must not light /status green. The banner
          // still renders cached data (read-time expiry bounds how stale it
          // can be); only the affirmative "live" claim waits for the server.
          if (!snap.metadata.fromCache) setConnection("live");
        },
        () => {
          // Permission/connectivity failure → fail open, notice off.
          setRaw(null);
          setConnection("error");
        },
      );
    } catch {
      // Firebase init failure (missing config, etc) → never subscribed, and
      // `raw` still holds its initial null → fail open, notice off.
      // (Microtask keeps the setState out of the effect's synchronous body.)
      queueMicrotask(() => setConnection("error"));
    }
    return () => {
      clearTimeout(staleTimer);
      unsubscribe?.();
    };
  }, []);

  const notice = useMemo(() => {
    void expiryTick;
    try {
      return normaliseSiteNotice(raw, new Date());
    } catch {
      return DEFAULT_SITE_NOTICE;
    }
  }, [raw, expiryTick]);

  useEffect(() => {
    if (!notice.bannerVisible || notice.expiresAt === null) return;
    const delay = notice.expiresAt.getTime() - Date.now() + 1000;
    if (delay <= 0) return;
    // setTimeout clamps to a 32-bit ms range; beyond that the timer is
    // pointless anyway (nobody keeps a tab open for 24+ days).
    const id = setTimeout(
      () => setExpiryTick((t) => t + 1),
      Math.min(delay, 2 ** 31 - 1),
    );
    return () => clearTimeout(id);
  }, [notice]);

  return { notice, connection };
}

export function useSiteNotice(): SiteNotice {
  return useSiteNoticeState().notice;
}
