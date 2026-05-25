"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Card from "@/components/ui/Card";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import { exchangeGoogleCredential } from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";
import { bypass } from "@/lib/devBypass";
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

  const [error, setError] = useState<string | null>(null);
  // True while a credential exchange is in flight. Gates the bounce
  // effect so it can't race the cookie POST: signInWithCredential fires
  // onAuthStateChanged before /api/auth/session has minted the cookie;
  // without this guard the bounce would router.replace to `next`, the
  // server would see no session cookie, and bounce us back to /login.
  const [loading, setLoading] = useState(false);
  // Set true once an explicit router.push has fired. Stops the bounce
  // effect from emitting a redundant replace after the credential-exchange
  // path navigates. Ref (not state) so it doesn't trigger a re-render.
  const handledNavRef = useRef(false);

  useEffect(() => {
    mark("[login] render", { authLoading, user: user?.uid ?? null, role, next, pathname });
  }, [authLoading, user, role, next, pathname]);

  // Already signed in? Bounce away based on role. Runs in two scenarios:
  //   (a) user navigated to /login while already signed in elsewhere
  //   (b) One Tap auto-signed them in and the credential-exchange path
  //       hasn't navigated yet — handled by the `loading` guard.
  useEffect(() => {
    if (authLoading || !user) return;
    // The dev bypass auto-signs the user in as a fake admin. Don't bounce
    // them off /login when they're trying to start a real sign-in: the
    // moment they complete the credential flow, the real session cookie
    // wins over the bypass everywhere (defer-to-real-session).
    const bypassUser = bypass.getAuthUser();
    if (bypassUser && user.uid === bypassUser.uid) {
      mark("[login] bounce-effect skipped: dev-bypass admin");
      return;
    }
    if (loading) {
      mark("[login] bounce-effect skipped: signin in flight");
      return;
    }
    if (handledNavRef.current) return;
    if (role === "member" || role === "committee" || role === "admin") {
      mark(`[login] bounce-effect → ${next} (role=${role})`);
      router.replace(next);
    } else if (role === "pending") {
      router.replace("/pending-approval");
    } else if (role === "rejected") {
      router.replace("/");
    }
    // user but no role yet — Firestore snapshot probably hasn't fired.
    // Effect will re-run when role lands; no navigation here.
  }, [authLoading, user, role, next, router, loading]);

  const onCredential = useCallback(
    async (idToken: string) => {
      mark("[login] onCredential start");
      setError(null);
      setLoading(true);
      try {
        const result = await exchangeGoogleCredential(idToken);
        mark("[login] credential exchanged", { isNew: result.isNew, uid: result.uid });
        if (result.isNew) {
          router.push("/register");
        } else {
          router.push(next);
        }
        handledNavRef.current = true;
      } catch (err) {
        warn("[login] onCredential threw", err);
        console.error(err);
        setError("Sign-in failed. Please try again.");
        setLoading(false);
      }
    },
    [router, next],
  );

  const onScriptError = useCallback((message: string) => {
    setError(message);
  }, []);

  return (
    <Card padding="lg" style={{ width: "100%", maxWidth: "26rem" }}>
      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
        Welcome back
      </h1>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
        Sign in to access your dashboard, tasks, and course materials.
      </p>
      <GoogleSignInButton onCredential={onCredential} onScriptError={onScriptError} />
      {loading && (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginTop: "var(--space-4)" }}>
          Signing in…
        </p>
      )}
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
