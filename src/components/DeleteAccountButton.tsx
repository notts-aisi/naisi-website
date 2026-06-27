"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteOwnAccount } from "@/auth/signInWithEmailPassword";

/**
 * "Delete account" affordance for an UNFINISHED registration — someone who
 * registered and set a password but doesn't want to finish their profile /
 * application. Two-step inline confirm → strict server cascade
 * (`POST /api/account/delete`, scope-enforced server-side to unfinished
 * accounts) → sign out → home. A refusal/failure surfaces the error inline and
 * does NOT redirect (the account still exists).
 */
const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
};

export default function DeleteAccountButton() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteOwnAccount();
      router.replace("/");
    } catch (e) {
      // Stay on the confirm UI so the user can read the error and retry/cancel.
      setError(e instanceof Error ? e.message : "Couldn't delete this account.");
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        style={{ ...linkStyle, color: "var(--color-danger)" }}
      >
        Delete account
      </button>
    );
  }

  return (
    <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
      Permanently delete this account?{" "}
      <button
        type="button"
        onClick={() => void onConfirm()}
        disabled={busy}
        style={{ ...linkStyle, color: "var(--color-danger)", fontWeight: 600 }}
      >
        {busy ? "Deleting…" : "Yes, delete"}
      </button>{" "}
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        disabled={busy}
        style={{ ...linkStyle, color: "var(--color-accent)" }}
      >
        Cancel
      </button>
      {error && (
        <span style={{ display: "block", marginTop: "var(--space-1)", color: "var(--color-danger)" }}>
          {error}
        </span>
      )}
    </span>
  );
}
