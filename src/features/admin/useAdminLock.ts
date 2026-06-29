"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";

// A lock is "live" while its heartbeat is younger than the TTL. The holder
// refreshes the heartbeat well inside that window; a hard browser close stops
// the heartbeat, so the lock self-expires within TTL (the "1 minute lag").
export const LOCK_TTL_MS = 60_000;
const HEARTBEAT_MS = 55_000;
// A waiting admin can message the current holder once they have waited this long.
const MESSAGE_GATE_MS = 60_000;

export type LockMessage = {
  id: string;
  fromUid: string;
  fromName: string;
  text: string;
  createdAtMs: number;
};

function holderName(user: User | null): string {
  return user?.displayName ?? user?.email ?? "An admin";
}

function heartbeatMs(data: Record<string, unknown> | null): number {
  const hb = data?.heartbeatAt as Timestamp | undefined;
  return typeof hb?.toMillis === "function" ? hb.toMillis() : 0;
}

/**
 * Core lease: try to acquire `adminLocks/{lockId}` (only if free, stale, or
 * already mine), heartbeat while held, and release on tab-leave / unmount /
 * page hide. Everything is wrapped so a failure FAILS OPEN — a broken lock never
 * blocks an admin, it just stops coordinating. Returns whether I hold it and, if
 * not, the name of whoever currently does.
 */
function useLease(
  lockId: string | null,
  fields: Record<string, unknown>,
  enabled: boolean,
) {
  const [held, setHeld] = useState(false);
  const [blockedBy, setBlockedBy] = useState<string | null>(null);
  const heldRef = useRef(false);
  const fieldsRef = useRef(fields);
  // Keep the latest fields available to the effect without making it a dep
  // (updated in an effect, not during render).
  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  useEffect(() => {
    if (!enabled || !lockId) {
      heldRef.current = false;
      return; // return value is derived as off below; no setState needed
    }
    const db = getClientDb();
    const ref = doc(db, "adminLocks", lockId);
    const holderUid = fieldsRef.current.holderUid as string;
    let cancelled = false;

    const tryAcquire = async () => {
      // Don't (re)acquire while the tab is hidden — otherwise the delete that
      // release() does on tab-hide would be instantly undone by this same tab's
      // snapshot handler, so the lock would never actually free on a tab switch.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
          const fresh = data !== null && Date.now() - heartbeatMs(data) < LOCK_TTL_MS;
          if (fresh && data!.holderUid !== holderUid) return; // someone else holds it
          tx.set(ref, {
            ...fieldsRef.current,
            heartbeatAt: serverTimestamp(),
            acquiredAt:
              data && data.holderUid === holderUid && data.acquiredAt
                ? data.acquiredAt
                : serverTimestamp(),
          });
        });
      } catch {
        /* fail open — leave state as-is, don't block */
      }
    };

    void tryAcquire();

    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (cancelled) return;
        const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
        const fresh = data !== null && Date.now() - heartbeatMs(data) < LOCK_TTL_MS;
        if (!fresh) {
          heldRef.current = false;
          setHeld(false);
          setBlockedBy(null);
          void tryAcquire();
          return;
        }
        if (data!.holderUid === holderUid) {
          heldRef.current = true;
          setHeld(true);
          setBlockedBy(null);
        } else {
          heldRef.current = false;
          setHeld(false);
          setBlockedBy((data!.holderName as string) || "Another admin");
        }
      },
      () => {
        // Permission/connectivity failure → fail open.
        if (cancelled) return;
        heldRef.current = false;
        setHeld(false);
        setBlockedBy(null);
      },
    );

    // Coming back to the tab: re-attempt acquisition (the snapshot alone won't,
    // since tryAcquire is gated on visibility above).
    const onVisible = () => {
      if (document.visibilityState === "visible") void tryAcquire();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      unsub();
    };
  }, [enabled, lockId]);

  // Heartbeat while held.
  useEffect(() => {
    if (!held || !lockId) return;
    const db = getClientDb();
    const ref = doc(db, "adminLocks", lockId);
    const id = setInterval(() => {
      updateDoc(ref, { heartbeatAt: serverTimestamp() }).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [held, lockId]);

  // Release on leaving the tab, unmounting, or closing the page. A hard close
  // that fires none of these is covered by the TTL.
  useEffect(() => {
    if (!enabled || !lockId) return;
    const db = getClientDb();
    const ref = doc(db, "adminLocks", lockId);
    const release = () => {
      if (!heldRef.current) return;
      heldRef.current = false;
      deleteDoc(ref).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("pagehide", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [enabled, lockId]);

  // Force "off" when disabled rather than resetting state inside the effect.
  const on = enabled && Boolean(lockId);
  return { held: on ? held : false, blockedBy: on ? blockedBy : null };
}

/** The holder reads recent messages others left on this lock; anyone with access can post one. */
function useLockMessages(lockId: string | null, enabled: boolean) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<LockMessage[]>([]);

  useEffect(() => {
    if (!enabled || !lockId) return; // return value is derived below
    const db = getClientDb();
    const q = query(
      collection(db, "adminLocks", lockId, "messages"),
      orderBy("createdAt", "desc"),
      limit(10),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setMessages(
          snap.docs.map((d) => {
            const data = d.data();
            const ts = data.createdAt as Timestamp | undefined;
            return {
              id: d.id,
              fromUid: typeof data.fromUid === "string" ? data.fromUid : "",
              fromName: typeof data.fromName === "string" ? data.fromName : "Someone",
              text: typeof data.text === "string" ? data.text : "",
              createdAtMs: typeof ts?.toMillis === "function" ? ts.toMillis() : Date.now(),
            };
          }),
        );
      },
      () => setMessages([]),
    );
    return unsub;
  }, [enabled, lockId]);

  const visibleMessages = enabled && lockId ? messages : [];

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !lockId || !user) return;
      try {
        await addDoc(collection(getClientDb(), "adminLocks", lockId, "messages"), {
          fromUid: user.uid,
          fromName: holderName(user),
          text: trimmed.slice(0, 500),
          createdAt: serverTimestamp(),
        });
      } catch {
        /* best-effort */
      }
    },
    [lockId, user],
  );

  return { messages: visibleMessages, send };
}

export type PageLockStatus = "off" | "held" | "waiting";

/**
 * One-admin-at-a-time presence lease for an admin page. While another admin
 * holds it this returns status "waiting" with their name and a countdown; once
 * the countdown elapses the waiting admin may message the holder. The page
 * auto-acquires the moment the holder leaves or their lock expires.
 */
export function useAdminPageLock(pageKey: string | null) {
  const { user, role } = useAuth();
  const enabled = Boolean(pageKey) && role === "admin" && Boolean(user);
  const lockId = pageKey ? `page__${pageKey}` : null;

  const fields = useMemo(
    () => ({
      scope: "page",
      pageKey: pageKey ?? "",
      holderUid: user?.uid ?? "",
      holderName: holderName(user),
    }),
    [pageKey, user],
  );

  const { held, blockedBy } = useLease(lockId, fields, enabled);
  const status: PageLockStatus = !enabled
    ? "off"
    : blockedBy
      ? "waiting"
      : held
        ? "held"
        : "off";

  // Countdown while waiting: gates the "send a message" affordance.
  const [waitMs, setWaitMs] = useState(0);
  const waitStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== "waiting") {
      waitStartRef.current = null;
      return; // effectiveWaitMs is derived as 0 below
    }
    waitStartRef.current = Date.now();
    const tick = () => setWaitMs(Date.now() - (waitStartRef.current ?? Date.now()));
    // Reset to ~0 immediately (async, so not a render-time setState) so a second
    // wait in the same session doesn't inherit the previous wait's elapsed time.
    const t0 = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [status]);

  // Messaging: the holder reads incoming messages; the waiter sends them.
  const inbox = useLockMessages(lockId, status === "held");
  const outbox = useLockMessages(lockId, status === "waiting");

  const effectiveWaitMs = status === "waiting" ? waitMs : 0;
  const canMessage = status === "waiting" && effectiveWaitMs >= MESSAGE_GATE_MS;
  const countdownMs = Math.max(0, MESSAGE_GATE_MS - effectiveWaitMs);

  return {
    status,
    holderName: blockedBy ?? "",
    countdownMs,
    canMessage,
    sendMessage: outbox.send,
    incoming: status === "held" ? inbox.messages : [],
  };
}

/**
 * Admin side of the "under maintenance" lock: while `active` (the edit form is
 * open) it holds `useredit__{targetUid}` so the member sees a maintenance notice
 * on their profile. Returns any messages the member sent back.
 */
export function useUserEditLock(targetUid: string | null, active: boolean) {
  const { user, role } = useAuth();
  const enabled = Boolean(targetUid) && active && role === "admin" && Boolean(user);
  const lockId = targetUid ? `useredit__${targetUid}` : null;

  // No holderName on a user-edit lock: the member can read this doc (by id
  // pattern), and the maintenance notice deliberately doesn't name the admin, so
  // we never store the admin's name/email here.
  const fields = useMemo(
    () => ({
      scope: "user-edit",
      targetUid: targetUid ?? "",
      holderUid: user?.uid ?? "",
    }),
    [targetUid, user],
  );

  useLease(lockId, fields, enabled);
  const { messages } = useLockMessages(lockId, enabled);
  return { messages };
}

/**
 * Member side: watch `useredit__{myUid}` and report when an admin is currently
 * editing this member's details, so the profile page can show a maintenance
 * notice and let them message the admin. Read-only on the lock; can post a
 * message.
 */
export function useMaintenanceWatch(myUid: string | null) {
  const [active, setActive] = useState(false);
  const lastHbRef = useRef(0);
  const lockId = myUid ? `useredit__${myUid}` : null;

  useEffect(() => {
    if (!lockId) {
      lastHbRef.current = 0;
      return; // return value is derived below; no setState needed
    }
    const db = getClientDb();
    const ref = doc(db, "adminLocks", lockId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
        lastHbRef.current = data ? heartbeatMs(data) : 0;
        setActive(lastHbRef.current > 0 && Date.now() - lastHbRef.current < LOCK_TTL_MS);
      },
      () => {
        lastHbRef.current = 0;
        setActive(false);
      },
    );
    return unsub;
  }, [lockId]);

  // Recompute liveness on a timer so a lapsed heartbeat (a hard close that never
  // deleted the doc) clears the notice even without a fresh snapshot.
  useEffect(() => {
    const id = setInterval(() => {
      setActive(lastHbRef.current > 0 && Date.now() - lastHbRef.current < LOCK_TTL_MS);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const { send } = useLockMessages(lockId, active);
  return { active: Boolean(lockId) && active, sendMessage: send };
}
