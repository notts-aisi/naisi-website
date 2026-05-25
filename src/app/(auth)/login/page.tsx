"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { consumeGoogleRedirect, signInWithGoogle } from "@/auth/signInWithGoogle";
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

  // Hoisted above the bounce effect because the effect's guard reads
  // `loading` (the signing-in flag) to avoid racing the post-redirect
  // cookie POST. See the bounce-effect block below for the why.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // True while we're consuming a post-redirect result on mount. Initially
  // true so the bounce effect can't fire before we've had a chance to
  // check for a pending redirect — without this, onAuthStateChanged fires
  // before /api/auth/session has minted the cookie, the bounce sends us
  // to `next`, and the server layout bounces us right back to /login.
  const [consumingRedirect, setConsumingRedirect] = useState(true);
  // Set true once any explicit router.push has fired. After that the
  // bounce effect should stay quiet for the rest of this LoginInner
  // lifetime — otherwise it re-runs and emits a redundant replace to
  // the same path. Ref (not state) because we don't need a re-render.
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
  // The `loading` and `consumingRedirect` guards are load-bearing. Without
  // them the effect races the post-redirect handoff: Firebase Auth restores
  // the user from the redirect result (so useAuth() reports user+role)
  // BEFORE the cookie POST to /api/auth/session completes. The effect would
  // then fire router.replace(next), the server-side (app)/layout.tsx would
  // read the (not yet set) __session cookie, see no session, and redirect
  // back to /login. The consume effect drives its own navigation post-
  // cookie-set, so skipping the bounce while a sign-in is in flight is
  // safe — and necessary.
  useEffect(() => {
    if (authLoading || !user) return;
    // The dev bypass auto-signs the user in as a fake admin. Don't bounce
    // them off /login when they're trying to start a real sign-in: the
    // moment they complete the redirect flow, the real session cookie wins
    // over the bypass everywhere (defer-to-real-session). Skipping here
    // is the only place the bypass admin gets to sit on /login.
    const bypassUser = bypass.getAuthUser();
    if (bypassUser && user.uid === bypassUser.uid) {
      mark("[login] bounce-effect skipped: dev-bypass admin, letting real sign-in proceed");
      return;
    }
    if (consumingRedirect) {
      mark("[login] bounce-effect skipped: consuming redirect result");
      return;
    }
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
  }, [authLoading, user, role, next, router, loading, consumingRedirect]);

  // Consume a pending Google redirect result on mount. Most page loads
  // have no pending redirect (consume returns null) and this is a quick
  // no-op; on a sign-in return, this is where the session cookie gets
  // minted and the routing decision (new user → /register, else → next)
  // happens.
  //
  // The `cancelled` flag is the standard "ignore late results from an
  // unmounted component" guard. It works correctly with Strict Mode here
  // because consumeGoogleRedirect dedupes the underlying Firebase call at
  // module scope — both effect runs await the same promise and see the
  // same SignInResult; only the active (non-cancelled) one routes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        console.log("[login] consume effect start");
        mark("[login] consumeGoogleRedirect start");
        const result = await consumeGoogleRedirect();
        console.log("[login] consume effect: got result", { result, cancelled });
        if (cancelled) return;
        if (!result) {
          mark("[login] no pending redirect — normal page load");
          setConsumingRedirect(false);
          return;
        }
        mark("[login] redirect consumed", { isNew: result.isNew, uid: result.uid });
        if (result.isNew) {
          console.log("[login] routing → /register (new user)");
          mark("[login] router.push → /register (new user)");
          router.push("/register");
        } else {
          console.log(`[login] routing → ${next}`);
          mark(`[login] router.push → ${next}`);
          router.push(next);
        }
        handledNavRef.current = true;
        // [monitor] Smoking-gun watchdog: if pathname is still /login 6s
        // after a successful signin, the navigation never landed (likely
        // a cookie-propagation race in (app)/layout.tsx or a silent
        // router.push fail).
        setTimeout(() => {
          if (window.location.pathname === "/login") {
            warn("[login] STILL ON /login 6s after successful signin", {
              currentPath: window.location.pathname,
            });
          }
        }, 6000);
      } catch (err) {
        if (cancelled) return;
        console.error("[login] consume effect threw", err);
        warn("[login] consumeGoogleRedirect threw", err);
        setError("Sign-in failed. Please try again.");
        setConsumingRedirect(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, next]);

  async function handleSignIn() {
    mark("[login] handleSignIn start");
    setError(null);
    setLoading(true);
    try {
      // Two return paths: popup (localhost) resolves with SignInResult
      // inline; redirect (deployed) navigates the browser away and
      // resolves to null — the consume effect picks up the result on
      // the post-OAuth mount.
      const result = await signInWithGoogle();
      if (!result) {
        mark("[login] redirect dispatched — consume effect will handle return");
        return;
      }
      mark("[login] popup resolved inline", { isNew: result.isNew, uid: result.uid });
      if (result.isNew) {
        router.push("/register");
      } else {
        router.push(next);
      }
      handledNavRef.current = true;
    } catch (err) {
      warn("[login] handleSignIn threw", err);
      console.error(err);
      setError("Sign-in failed. Please try again.");
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
