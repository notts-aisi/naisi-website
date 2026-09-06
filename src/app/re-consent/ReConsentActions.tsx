"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { signOut } from "@/auth/signInWithGoogle";
import { hardNavigate } from "@/lib/navigation/hardNavigate";

/**
 * Accept / decline controls for the re-consent gate.
 *  - Accept       → stamp the new policy version, return to where they were going.
 *  - Members      → decline = sign out (access stays blocked until they accept on
 *                   a later sign-in); deletion is admin-handled (no member content
 *                   cascade yet), so we point them at support rather than offering
 *                   a self-delete that would strand task/event references.
 *  - Collaborators → decline = self-delete via the shared cascade (it's complete
 *                    for collaborators), behind a two-step confirm.
 */
export default function ReConsentActions({
  isMember,
  homeHref,
  supportEmail,
}: {
  isMember: boolean;
  homeHref: string;
  supportEmail: string;
}) {
  const [busy, setBusy] = useState<null | "accept" | "decline">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function accept() {
    setError(null);
    setBusy("accept");
    try {
      const res = await fetch("/api/account/reconsent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? "Couldn't save your acceptance. Please try again.");
      }
      // Hard nav, and NOT router.refresh(). The user is on /re-consent because
      // the authed layout ((app)/layout.tsx, or collaborator/layout.tsx) threw
      // redirect("/re-consent") on a navigation to homeHref, so this
      // document's route cache maps homeHref -> /re-consent.
      // router.refresh() cannot clear that — it invalidates segment entries
      // only (refresh-reducer.js:29-32) — which is exactly what made the old
      // code look correct while bouncing the user straight back at the consent
      // wall they just cleared. See lib/navigation/hardNavigate.ts.
      hardNavigate(homeHref, "replace");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(null);
    }
  }

  async function signOutOnly() {
    setBusy("decline");
    try {
      await signOut();
    } catch {
      /* best-effort — redirect regardless */
    }
    // Hard nav: the session cookie was just cleared, so every authed RSC
    // payload this document holds is stale.
    hardNavigate("/login", "replace");
  }

  async function deleteAccount() {
    setError(null);
    setBusy("decline");
    try {
      const res = await fetch("/api/account/reconsent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      });
      if (!res.ok && res.status !== 207) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? "Couldn't delete your account. Please try again.");
      }
      try {
        await signOut();
      } catch {
        /* the account is gone; redirect regardless */
      }
      // Hard nav: the account no longer exists, so nothing cached for it is
      // safe to reuse.
      hardNavigate("/", "replace");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: "var(--space-5)" }}>
      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <Button onClick={accept} disabled={busy !== null} data-testid="reconsent-accept">
          {busy === "accept" ? "Saving…" : "Accept and continue"}
        </Button>
        {isMember ? (
          <Button variant="secondary" onClick={signOutOnly} disabled={busy !== null}>
            {busy === "decline" ? "Signing out…" : "I don't accept"}
          </Button>
        ) : !confirmDelete ? (
          <Button
            variant="secondary"
            onClick={() => setConfirmDelete(true)}
            disabled={busy !== null}
          >
            I don&apos;t accept
          </Button>
        ) : (
          <Button variant="danger" onClick={deleteAccount} disabled={busy !== null}>
            {busy === "decline" ? "Deleting…" : "Delete my account"}
          </Button>
        )}
      </div>

      {isMember && (
        <p
          style={{
            marginTop: "var(--space-3)",
            marginBottom: 0,
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
          }}
        >
          If you don&apos;t accept, you&apos;ll be signed out. To delete your
          account, email{" "}
          <a href={`mailto:${supportEmail}`} style={{ color: "var(--color-accent)" }}>
            {supportEmail}
          </a>
          .
        </p>
      )}

      {!isMember && confirmDelete && (
        <p
          style={{
            marginTop: "var(--space-3)",
            marginBottom: 0,
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
          }}
        >
          This permanently deletes your application and account. This can&apos;t
          be undone.
        </p>
      )}

      {error && (
        <p
          style={{
            marginTop: "var(--space-3)",
            marginBottom: 0,
            fontSize: "var(--text-sm)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
