"use client";

import { useEffect, useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import Button from "@/components/ui/Button";
import { getClientAuth } from "@/lib/firebase/client";

type Props = {
  email: string | null;
  /** Called the moment the email is confirmed verified. Pass a STABLE callback
   *  (useCallback) — it's an effect dependency. */
  onVerified: () => void;
  onStartOver: () => void;
  startingOver?: boolean;
};

/**
 * The "verify your email" gate shown between creating an email/password account
 * and the application/profile form. emailVerified is Firebase Auth state (not
 * Firestore, and Auth has no realtime listener), so we advance by reloading the
 * user on mount and whenever they return to the tab — e.g. back from clicking
 * the verification link. A manual "I've verified" button + a resend cover the
 * cases where the focus/visibility signal doesn't fire (same-tab, etc.).
 */
export default function VerifyEmailStep({
  email,
  onVerified,
  onStartOver,
  startingOver,
}: Props) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!active) return;
      const current = getClientAuth().currentUser;
      if (!current) return;
      try {
        await current.reload();
      } catch {
        return;
      }
      if (active && current.emailVerified) onVerified();
    };
    const onWake = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    void check();
    return () => {
      active = false;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [onVerified]);

  async function resend() {
    const current = getClientAuth().currentUser;
    if (!current) return;
    setBusy(true);
    try {
      await sendEmailVerification(current);
      setNote("Verification email sent — check your inbox (and spam).");
    } catch {
      setNote("Couldn't send right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function recheck() {
    const current = getClientAuth().currentUser;
    if (!current) return;
    try {
      await current.reload();
    } catch {
      /* ignore — fall through to the not-verified note */
    }
    if (current.emailVerified) onVerified();
    else setNote("Not verified yet — open the link we emailed you, then try again.");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        We&apos;ve sent a verification link to{" "}
        <strong style={{ color: "var(--color-text)" }}>{email}</strong>. Open it, then
        come back — this page continues automatically once you&apos;re verified.
      </p>
      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <Button onClick={() => void recheck()}>I&apos;ve verified</Button>
        <Button variant="secondary" onClick={() => void resend()} disabled={busy}>
          {busy ? "Sending…" : "Resend email"}
        </Button>
      </div>
      {note && (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", margin: 0 }}>
          {note}
        </p>
      )}
      <p style={{ color: "var(--color-text-subtle)", fontSize: "var(--text-sm)", margin: 0 }}>
        Wrong email?{" "}
        <button
          type="button"
          onClick={onStartOver}
          disabled={startingOver}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "var(--color-accent)",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          {startingOver ? "Starting over…" : "Start over with a different email"}
        </button>
      </p>
    </div>
  );
}
