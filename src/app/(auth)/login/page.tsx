"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { signInWithGoogle } from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";
import { mark, warn } from "@/lib/devMonitor";

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
  const pathname = usePathname();
  const next = params.get("next") ?? "/dashboard";
  const { user, role, loading: authLoading } = useAuth();

  // Hoisted above the bounce effect because the effect's guard reads
  // `loading` (the signing-in flag) to avoid racing handleSignIn's own
  // cookie POST. See the bounce-effect block below for the why.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set true once handleSignIn's own router.push has fired. After that
  // the bounce effect should stay quiet for the rest of this LoginInner
  // lifetime — otherwise it re-runs when `loading` flips false in the
  // finally and emits a redundant router.replace to the same path. Ref
  // (not state) because we don't need a re-render when it flips.
  const handledNavRef = useRef(false);

  // [monitor] Page-mount + auth-state snapshot. Logged on every render so
  // we can see exactly what useAuth() reported each time the bounce effect
  // below re-evaluated. The "stays on /login" failure mode is almost
  // certainly visible here as a sequence of (user=null, role=null) →
  // (user=set, role=null) → (user=set, role=member) and we want to see
  // which transitions did / didn't trigger a navigation.
  useEffect(() => {
    mark("[login] render", { authLoading, user: user?.uid ?? null, role, next, pathname });
  }, [authLoading, user, role, next, pathname]);

  // Already signed in? Bounce away based on role.
  //
  // The `loading` guard is load-bearing. Without it the effect races the
  // active signInWithGoogle handoff: signInWithPopup updates Firebase Auth
  // client state (so useAuth() reports user+role) BEFORE the cookie POST
  // to /api/auth/session completes. The effect then fires
  // router.replace(next), the server-side (app)/layout.tsx reads the (not
  // yet set) __session cookie, sees no session, and redirects back to
  // /login. handleSignIn drives its own navigation post-cookie-set, so
  // skipping the bounce while a sign-in is in flight is safe — and
  // necessary.
  useEffect(() => {
    if (authLoading || !user) return;
    if (loading) {
      mark("[login] bounce-effect skipped: signin in flight");
      return;
    }
    if (handledNavRef.current) {
      mark("[login] bounce-effect skipped: handleSignIn already navigated");
      return;
    }
    if (role === "member" || role === "committee" || role === "admin") {
      mark(`[login] bounce-effect → ${next} (role=${role})`);
      router.replace(next);
    } else if (role === "pending") {
      mark("[login] bounce-effect → /pending-approval");
      router.replace("/pending-approval");
    } else if (role === "rejected") {
      mark("[login] bounce-effect → / (rejected)");
      router.replace("/");
    } else {
      // user exists, no role yet — Firestore snapshot probably hasn't
      // fired. Effect will re-run when role lands; no navigation here.
      mark("[login] bounce-effect: user but no role yet — waiting", { role });
    }
  }, [authLoading, user, role, next, router, loading]);

  async function handleSignIn() {
    mark("[login] handleSignIn start");
    setError(null);
    setLoading(true);
    try {
      const result = await signInWithGoogle();
      mark("[login] signInWithGoogle resolved", { isNew: result.isNew, uid: result.uid });
      if (result.isNew) {
        mark("[login] router.push → /register (new user)");
        router.push("/register");
        handledNavRef.current = true;
        return;
      }
      // Server-side (app)/layout.tsx routes pending/rejected users onward
      // based on the freshly-minted session cookie.
      mark(`[login] router.push → ${next}`);
      router.push(next);
      handledNavRef.current = true;
      // [monitor] Smoking-gun watchdog: if pathname is still /login 6s
      // after a successful signin, the navigation never landed (likely
      // a cookie-propagation race in (app)/layout.tsx, a double-push
      // collision with the bounce effect, or a silent router.push fail).
      // Cleared if any other effect fires that navigates us away.
      setTimeout(() => {
        if (window.location.pathname === "/login") {
          warn("[login] STILL ON /login 6s after successful signin", {
            currentPath: window.location.pathname,
            authState: { user: !!user, role, authLoading },
          });
        }
      }, 6000);
    } catch (err) {
      warn("[login] handleSignIn threw", err);
      console.error(err);
      setError("Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
      mark("[login] handleSignIn finally");
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
