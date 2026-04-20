"use client";

import Link from "next/link";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { signOut } from "@/auth/signInWithGoogle";
import { useRouter } from "next/navigation";

export default function PendingApprovalPage() {
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  return (
    <Card padding="lg" style={{ width: "100%", maxWidth: "28rem", textAlign: "center" }}>
      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-3)" }}>
        Application received
      </h1>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
        Thanks for signing up. The committee will review your application shortly — you&apos;ll get
        an email the moment you&apos;re approved.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <Link href="/" style={{ color: "var(--color-accent)", fontSize: "var(--text-sm)" }}>
          ← Back to the homepage
        </Link>
        <Button onClick={handleSignOut} variant="ghost" size="sm">
          Sign out
        </Button>
      </div>
    </Card>
  );
}
