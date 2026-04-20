"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { signInWithGoogle } from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginSkeleton() {
  return (
    <Card padding="lg" style={{ width: "100%", maxWidth: "26rem", minHeight: "14rem" }}>
      <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
    </Card>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";
  const { user, role, loading: authLoading } = useAuth();

  // Already signed in? Bounce away based on role.
  useEffect(() => {
    if (authLoading || !user) return;
    if (role === "member" || role === "committee" || role === "admin") {
      router.replace(next);
    } else if (role === "pending") {
      router.replace("/pending-approval");
    } else if (role === "rejected") {
      router.replace("/");
    }
  }, [authLoading, user, role, next, router]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    setError(null);
    setLoading(true);
    try {
      const result = await signInWithGoogle();
      if (result.isNew) {
        router.push("/register");
        return;
      }
      // Server-side (app)/layout.tsx routes pending/rejected users onward
      // based on the freshly-minted session cookie.
      router.push(next);
    } catch (err) {
      console.error(err);
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card padding="lg" style={{ width: "100%", maxWidth: "26rem" }}>
      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
        Welcome back
      </h1>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
        Sign in to access your dashboard, tasks, and course materials.
      </p>
      <Button onClick={handleSignIn} fullWidth size="lg" disabled={loading}>
        {loading ? "Signing in…" : "Continue with Google"}
      </Button>
      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)", marginTop: "var(--space-4)" }}>
          {error}
        </p>
      )}
      <p
        style={{
          color: "var(--color-text-muted)",
          fontSize: "var(--text-sm)",
          marginTop: "var(--space-6)",
          textAlign: "center",
        }}
      >
        New here?{" "}
        <Link href="/register" style={{ color: "var(--color-accent)" }}>
          Create an account
        </Link>
      </p>
    </Card>
  );
}
