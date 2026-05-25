"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Card from "@/components/ui/Card";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import SigningIn from "@/components/SigningIn";
import signinStyles from "@/components/SigningIn.module.css";
import { AUTH_BACK_HOME_EVENT, AUTH_PAGE_READY_EVENT } from "../LogoLink";
import { exchangeGoogleCredential } from "@/auth/signInWithGoogle";
import { useAuth } from "@/auth/AuthProvider";
import { bypass } from "@/lib/devBypass";
import { mark, warn } from "@/lib/devMonitor";

type SignInPhase = "idle" | "active" | "success" | "exiting" | "exitingBack";

/** Minimum time the active loader plays before we slip into the success
 *  sweep — keeps the cascade visible even if Firebase resolves the
 *  credential in <100ms. */
const MIN_ACTIVE_MS = 1700;
/** Green wavefront duration (must match LivingPlasma's `successDurationMs`). */
const SUCCESS_DURATION_MS = 2550;
/** Tail-hold after the wave finishes: gives the last nodes' smooth lock-in
 *  enough time to complete (LOCK_DELAY 110 + LOCK_RAMP 1090 ≈ 1200ms)
 *  plus a brief admire window before the card slides out. */
const SUCCESS_HOLD_TAIL_MS = 1330;
/** Card slide-out duration (matches .exitFrame transition CSS). Kept
 *  short so the dashboard fade-in kicks in soon after the slide starts. */
const EXIT_DURATION_MS = 530;
/** If the window regains focus this soon after blurring with no
 *  credential having arrived, treat it as a Google popup cancellation
 *  and drop back to idle. */
const CANCEL_GRACE_MS = 900;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

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
  // idle = ambient loader on the page (Waiting for user prompt).
  // active = surge mode after the Google button has been clicked, while
  //   the credential exchange + minimum animation time elapse.
  // exiting = card sliding off-screen, then router.push.
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [successAt, setSuccessAt] = useState<number | null>(null);
  // Card is hidden offscreen-right until GIS reports ready. We then
  // remove the .entering class and the card swipes in. Masks the GIS
  // "Loading sign-in…" placeholder + any layout shifts on first render.
  const [entering, setEntering] = useState(true);
  const activeStartRef = useRef(0);
  /** Set true the moment we receive a credential — used by the
   *  cancellation watchdog to know whether a focus-return is a popup
   *  dismissal or a successful credential exchange in flight. */
  const credentialReceivedRef = useRef(false);

  // Safety fallback: even if GIS never reports ready (script blocker,
  // misconfig), reveal the card after 3.2s. Accounts for GIS's own
  // 700ms personalisation-settle delay on top of the typical 500-1500ms
  // script load on slow networks.
  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => setEntering(false), 3200);
    return () => clearTimeout(t);
  }, [entering]);

  /** GIS reports ready synchronously after renderButton — but the
   *  iframe still has its own opacity-fade-in (150ms) and Google's
   *  internal layout pass to settle. If we start the card swipe in
   *  the same frame, the user perceives the button's fade-in as
   *  jitter against the moving card. Two paint frames + ~220ms lets
   *  it land cleanly first. */
  const handleGisReady = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          setEntering(false);
          // Logo in the auth layout's header listens for this and floats
          // in from the left, landing roughly in sync with the card.
          try {
            window.dispatchEvent(new CustomEvent(AUTH_PAGE_READY_EVENT));
          } catch {
            /* CustomEvent unavailable on truly ancient browsers */
          }
        }, 220);
      });
    });
  }, []);

  // Logo click → swipe back to the homepage. We intercept the layout's
  // custom event, animate the card off to the right (mirror of the
  // forward swipe-in), then router.push("/").
  useEffect(() => {
    const onBack = (e: Event) => {
      // Only handle when we're not already exiting / in success.
      if (phase === "exiting" || phase === "exitingBack" || phase === "success") return;
      e.preventDefault();
      setPhase("exitingBack");
      handledNavRef.current = true;
      setTimeout(() => router.push("/"), EXIT_DURATION_MS);
    };
    window.addEventListener(AUTH_BACK_HOME_EVENT, onBack);
    return () => window.removeEventListener(AUTH_BACK_HOME_EVENT, onBack);
  }, [phase, router]);
  // Set true once an explicit router.push has fired. Stops the bounce
  // effect from emitting a redundant replace after the credential-exchange
  // path navigates. Ref (not state) so it doesn't trigger a re-render.
  const handledNavRef = useRef(false);

  /** Flip into active mode. Called on Google-button click, and as a
   *  belt-and-braces fallback when the credential callback arrives if we
   *  somehow missed the click (e.g. iframe click didn't bubble). */
  const startSurge = useCallback(() => {
    setPhase((p) => {
      if (p !== "idle") return p;
      activeStartRef.current = performance.now();
      return "active";
    });
  }, []);

  // Click on the GIS iframe doesn't always bubble out, so we also watch
  // for window blur within ~1.5s of a recent mousedown. That covers the
  // common case: user clicks the button, popup steals focus, window
  // blurs — strong signal that a sign-in attempt has started.
  //
  // Same listener pair drives the inverse: if the window REGAINS focus
  // shortly after blur and no credential has arrived, the user has
  // dismissed Google's popup. We drop back to idle so the loader doesn't
  // get stuck in active forever.
  useEffect(() => {
    let lastMouseDown = 0;
    let lastBlurAt = 0;
    const onMouseDown = () => {
      lastMouseDown = performance.now();
    };
    const onBlur = () => {
      lastBlurAt = performance.now();
      if (phase === "idle" && performance.now() - lastMouseDown < 1500) {
        startSurge();
      }
    };
    const onFocus = () => {
      // Only count this as a cancellation if (a) we were mid-active,
      // (b) the blur was recent (popup-style), and (c) no credential
      // has been received since.
      if (phase !== "active") return;
      if (credentialReceivedRef.current) return;
      if (performance.now() - lastBlurAt > 3000) return;
      // Give the credential callback a moment — Firebase can fire it
      // a few hundred ms after focus returns in some browsers.
      setTimeout(() => {
        if (!credentialReceivedRef.current && phase === "active") {
          setPhase("idle");
        }
      }, CANCEL_GRACE_MS);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [phase, startSurge]);

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
    if (phase !== "idle") {
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
  }, [authLoading, user, role, next, router, phase]);

  const onCredential = useCallback(
    async (idToken: string) => {
      mark("[login] onCredential start");
      credentialReceivedRef.current = true;
      setError(null);
      // Belt-and-braces: if the click signal never landed, kick off surge
      // now so we still get the animation. activeStartRef gets stamped
      // here too in that case.
      startSurge();
      try {
        const result = await exchangeGoogleCredential(idToken);
        mark("[login] credential exchanged", { isNew: result.isNew, uid: result.uid });

        // Honour the minimum active window so the cascade plays through
        // even when Firebase resolves the credential in <100ms.
        const elapsed = performance.now() - activeStartRef.current;
        const remaining = Math.max(0, MIN_ACTIVE_MS - elapsed);
        if (remaining > 0) await sleep(remaining);

        // Success sweep: slow green wavefront locks every node green
        // with a smooth per-node attract. Hold past the wave's end so
        // the trailing edge nodes finish their lock-in animation before
        // we slide the card out.
        setSuccessAt(performance.now());
        setPhase("success");
        await sleep(SUCCESS_DURATION_MS + SUCCESS_HOLD_TAIL_MS);

        // Flag the destination page so its layout fades-in on mount.
        try {
          sessionStorage.setItem("naisi:from-signin", "1");
        } catch {
          /* sessionStorage may be unavailable; the fade-in is decorative */
        }

        setPhase("exiting");
        handledNavRef.current = true;
        await sleep(EXIT_DURATION_MS);
        router.push(result.isNew ? "/register" : next);
      } catch (err) {
        warn("[login] onCredential threw", err);
        console.error(err);
        setError("Sign-in failed. Please try again.");
        credentialReceivedRef.current = false;
        setSuccessAt(null);
        setPhase("idle");
      }
    },
    [router, next, startSurge],
  );

  const onScriptError = useCallback((message: string) => {
    setError(message);
  }, []);

  const frameClass = [
    signinStyles.exitFrame,
    entering ? signinStyles.entering : "",
    phase === "exiting" ? signinStyles.exiting : "",
    phase === "exitingBack" ? signinStyles.exitingBack : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={frameClass} style={{ maxWidth: "26rem" }}>
      <Card padding="lg" style={{ width: "100%" }}>
        <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-2)" }}>
          Welcome back
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-6)" }}>
          Sign in to access your dashboard, tasks, and course materials.
        </p>
        {/* onMouseDown catches GIS button clicks that DO bubble out of the
            iframe element; the window-blur fallback in the parent useEffect
            covers browsers that swallow them. */}
        <div onMouseDown={startSurge}>
          <GoogleSignInButton
            onCredential={onCredential}
            onScriptError={onScriptError}
            onReady={handleGisReady}
          />
        </div>
        <SigningIn
          active={phase !== "idle"}
          successStartAt={phase === "success" || phase === "exiting" ? successAt : null}
        />
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
    </div>
  );
}
