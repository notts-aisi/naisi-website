"use client";

import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import Button from "@/components/ui/Button";
import { signOut } from "@/auth/signInWithGoogle";
import { hardNavigate } from "@/lib/navigation/hardNavigate";

/** Minimal top bar for the collaborator area: brand link home + sign out. */
export default function CollaboratorTopBar({ name }: { name: string }) {
  async function handleSignOut() {
    await signOut();
    // Hard nav: the session cookie is cleared, so the authed /collaborator
    // payloads this document cached must not stay reachable.
    hardNavigate("/");
  }

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-3)",
        padding: "var(--space-4) var(--space-5)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <Link
        href="/"
        aria-label="NAISI home"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-3)",
          color: "var(--color-text)",
          textDecoration: "none",
        }}
      >
        <BrandMark size={28} />
        <span style={{ fontWeight: 600 }}>NAISI</span>
      </Link>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        {name && (
          <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            {name}
          </span>
        )}
        <Button onClick={handleSignOut} variant="ghost" size="sm">
          Sign out
        </Button>
      </div>
    </header>
  );
}
