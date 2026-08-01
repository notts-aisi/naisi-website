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
 * Live subscription to `publicConfig/siteNotice`. One instance is mounted for
 * the whole app (inside <SiteNoticeBanner /> in the root layout); Firestore
 * multiplexes the doc listen onto the connection AuthProvider already holds,
 * so this costs no extra bundle and no extra channel.
 *
 * FAIL-OPEN: any listener error (offline, permission-denied, a rules deploy
 * in flight) and any normalisation surprise resolves to DEFAULT_SITE_NOTICE —
 * notice off. Same shape as the useAdminLock error callback.
 */
export function useSiteNotice(): SiteNotice {
  const [raw, setRaw] = useState<unknown>(null);
  // Bumped when `expiresAt` passes so an already-open tab re-evaluates the
  // read-time expiry without needing a fresh snapshot from the server.
  const [expiryTick, setExpiryTick] = useState(0);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const db = getClientDb();
      const ref = doc(db, SITE_NOTICE_PATH.collection, SITE_NOTICE_PATH.doc);
      unsubscribe = onSnapshot(
        ref,
        (snap) => {
          setRaw(snap.exists() ? snap.data() : null);
        },
        () => {
          // Permission/connectivity failure → fail open, notice off.
          setRaw(null);
        },
      );
    } catch {
      // Firebase init failure (missing config, etc) → never subscribed, and
      // `raw` still holds its initial null → fail open, notice off.
    }
    return () => {
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

  return notice;
}
