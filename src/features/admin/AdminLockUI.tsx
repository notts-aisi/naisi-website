"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { useAdminPageLock, useMaintenanceWatch, type LockMessage } from "./useAdminLock";
import styles from "./adminLock.module.css";

function pageKeyFromPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-") || "admin";
}

/** Toasts the holder sees when waiting admins (or the member) message them. */
function MessageToasts({ messages }: { messages: LockMessage[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Only surface messages that arrived after this holder opened the page, so old
  // messages from a previous session don't pop as toasts. (Lazy init = one read,
  // not a render-time impure call.)
  const [openedAt] = useState(() => Date.now());
  const recent = messages.filter((m) => !dismissed.has(m.id) && m.createdAtMs >= openedAt);
  if (recent.length === 0) return null;
  return (
    <div className={styles.toasts} aria-live="polite">
      {recent.slice(0, 4).map((m) => (
        <div key={m.id} className={styles.toast}>
          <p className={styles.toastFrom}>{m.fromName}</p>
          <p className={styles.toastText}>{m.text}</p>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => setDismissed((prev) => new Set(prev).add(m.id))}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Per-page admin lease UI. Mounted once in the admin layout; it keys the lock on
 * the current admin route. While another admin holds the page it shows a blocking
 * (but escapable) overlay with a countdown, after which the waiting admin can
 * message the holder. The holder sees any messages as toasts. Fail-open: nothing
 * renders unless a fresh lock by someone else is confirmed.
 */
export default function AdminPageLockBar() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const pageKey = pathname.startsWith("/admin") ? pageKeyFromPath(pathname) : null;
  const lock = useAdminPageLock(pageKey);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);

  if (lock.status === "held") {
    return <MessageToasts messages={lock.incoming} />;
  }
  if (lock.status !== "waiting") return null;

  const secs = Math.ceil(lock.countdownMs / 1000);
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Page in use">
      <div className={styles.card}>
        <h2 className={styles.title}>{lock.holderName} is on this page</h2>
        <p className={styles.body}>
          To avoid clashing edits, one admin uses a page at a time. You&apos;ll get
          access automatically the moment they leave it.
        </p>
        {lock.canMessage ? (
          sent ? (
            <p className={styles.countdown}>Message sent.</p>
          ) : (
            <div className={styles.messageBox}>
              <textarea
                className={styles.textarea}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Send ${lock.holderName} a quick message…`}
                maxLength={500}
              />
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!draft.trim()}
                  onClick={() => {
                    void lock.sendMessage(draft);
                    setSent(true);
                  }}
                >
                  Send message
                </button>
              </div>
            </div>
          )
        ) : (
          <p className={styles.countdown}>
            You can message {lock.holderName} in {secs}s.
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => router.push("/dashboard")}
          >
            Leave this page
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Member-facing maintenance notice on the profile page: while an admin is editing
 * this member's details, show a blocking (escapable) overlay so the member doesn't
 * make clashing edits. The admin's name is NOT shown. After a minute the member
 * may message the admin.
 */
export function MaintenanceNotice() {
  const router = useRouter();
  const { user } = useAuth();
  const { active, sendMessage } = useMaintenanceWatch(user?.uid ?? null);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);
  // Allow messaging after a minute on the notice (gated by a timer, not a
  // render-time clock read).
  const [canMessage, setCanMessage] = useState(false);
  useEffect(() => {
    if (!active) return;
    // New maintenance session: restart the one-minute gate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanMessage(false);
    const id = setTimeout(() => setCanMessage(true), 60_000);
    return () => clearTimeout(id);
  }, [active]);

  if (!active) return null;
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Profile under maintenance">
      <div className={styles.card}>
        <h2 className={styles.title}>Your details are under maintenance</h2>
        <p className={styles.body}>
          A committee admin is updating your account details right now. To avoid
          clashing changes, editing is paused for a moment. This clears
          automatically when they finish.
        </p>
        {canMessage ? (
          sent ? (
            <p className={styles.countdown}>Message sent.</p>
          ) : (
            <div className={styles.messageBox}>
              <textarea
                className={styles.textarea}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Send the admin a quick message…"
                maxLength={500}
              />
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!draft.trim()}
                  onClick={() => {
                    void sendMessage(draft);
                    setSent(true);
                  }}
                >
                  Send message
                </button>
              </div>
            </div>
          )
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => router.push("/dashboard")}
          >
            Back to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
