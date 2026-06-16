"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import SigningIn from "@/components/SigningIn";
import signinStyles from "@/components/SigningIn.module.css";
import styles from "./register/registerSignIn.module.css";
import RegisterAudienceToggle, {
  type RegisterAudience,
} from "./register/RegisterAudienceToggle";
import AnimatedText from "./AnimatedText";
import { AUTH_BACK_HOME_EVENT, AUTH_PAGE_READY_EVENT } from "./LogoLink";
import { exchangeGoogleCredential } from "@/auth/signInWithGoogle";
import {
  resetCollaboratorPassword,
  signInWithEmailPassword,
} from "@/auth/signInWithEmailPassword";
import { useAuth } from "@/auth/AuthProvider";
import { getRecaptchaToken } from "@/lib/recaptcha/client";

type Mode = "signin" | "register";
type SignInPhase = "idle" | "active" | "success" | "exiting" | "exitingBack";

const MIN_ACTIVE_MS = 1700;
// Green left-to-right alignment sweep. ~30% faster than the original 2550 (must
// match LivingPlasma's successDurationMs default).
const SUCCESS_DURATION_MS = 1785;
const SUCCESS_HOLD_TAIL_MS = 1330;
const EXIT_DURATION_MS = 530;
const CANCEL_GRACE_MS = 900;
const RESEND_COOLDOWN_SECONDS = 60;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
// Shared timing for the in-place layout glides so the fields settle together
// instead of jerking in stages on a mode switch.
const LAYOUT_T = { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] } as const;

const TAGLINE: Record<RegisterAudience, string> = {
  member: "For current University of Nottingham students and staff.",
  collaborator: "For researchers and partners outside the University.",
};

/**
 * Unified auth entry — one morphing form for both sign-in and registration.
 * `/login` mounts it in "signin" mode, `/register` (signed-out) in "register"
 * mode; the top toggle flips between them in place. The Google
 * surge/success-sweep choreography is shared (and branched by mode so a register
 * sign-up isn't cut off mid-sweep). Registration submits to the enumeration-safe
 * server route and shows the uniform "check your inbox" screen.
 */
export default function AuthEntry({ initialMode }: { initialMode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";
  const { user, role, loading: authLoading } = useAuth();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [audience, setAudience] = useState<RegisterAudience>(
    params.get("type") === "collaborator" ? "collaborator" : "member",
  );
  // The ambient/sign-in animation is tucked away by default so it doesn't get in
  // the way; the little chevron above the action button reveals it. When hidden,
  // submits skip the (now-invisible) green sweep so there's no dead pause.
  const [loaderOpen, setLoaderOpen] = useState(false);
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [successAt, setSuccessAt] = useState<number | null>(null);
  const [entering, setEntering] = useState(true);
  const activeStartRef = useRef(0);
  const credentialReceivedRef = useRef(false);
  const handledNavRef = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [sentEmail, setSentEmail] = useState<string | null>(null);

  // Reveal fallback if GIS never reports ready.
  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => setEntering(false), 3200);
    return () => clearTimeout(t);
  }, [entering]);

  const handleGisReady = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          setEntering(false);
          try {
            window.dispatchEvent(new CustomEvent(AUTH_PAGE_READY_EVENT));
          } catch {
            /* CustomEvent unavailable */
          }
        }, 220);
      });
    });
  }, []);

  // Logo-click back-swipe.
  useEffect(() => {
    const onBack = (e: Event) => {
      if (phase === "exiting" || phase === "exitingBack" || phase === "success") return;
      e.preventDefault();
      setPhase("exitingBack");
      handledNavRef.current = true;
      setTimeout(() => router.push("/"), EXIT_DURATION_MS);
    };
    window.addEventListener(AUTH_BACK_HOME_EVENT, onBack);
    return () => window.removeEventListener(AUTH_BACK_HOME_EVENT, onBack);
  }, [phase, router]);

  const startSurge = useCallback(() => {
    setPhase((p) => {
      if (p !== "idle") return p;
      activeStartRef.current = performance.now();
      return "active";
    });
  }, []);

  // Plays the green "Model aligned" alignment sweep (shared by Google + the
  // email/password submit buttons). No-op when the loader is hidden, so a submit
  // never stalls on an invisible animation.
  const playSuccessSweep = useCallback(async () => {
    if (!loaderOpen) return;
    const elapsed = performance.now() - activeStartRef.current;
    const remaining = Math.max(0, MIN_ACTIVE_MS - elapsed);
    if (remaining > 0) await sleep(remaining);
    setSuccessAt(performance.now());
    setPhase("success");
    await sleep(SUCCESS_DURATION_MS + SUCCESS_HOLD_TAIL_MS);
  }, [loaderOpen]);

  // Google popup-cancellation watchdog (+ click-via-blur surge fallback).
  useEffect(() => {
    let lastMouseDown = 0;
    let lastBlurAt = 0;
    const onMouseDown = () => {
      lastMouseDown = performance.now();
    };
    const onBlur = () => {
      lastBlurAt = performance.now();
      if (phase === "idle" && performance.now() - lastMouseDown < 1500) startSurge();
    };
    const onFocus = () => {
      if (phase !== "active") return;
      if (credentialReceivedRef.current) return;
      if (performance.now() - lastBlurAt > 3000) return;
      setTimeout(() => {
        if (!credentialReceivedRef.current && phase === "active") setPhase("idle");
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

  // Already signed in? Bounce away (only meaningful in signin mode — in register
  // mode this component only mounts while signed out).
  useEffect(() => {
    if (authLoading || !user) return;
    if (phase !== "idle") return;
    if (handledNavRef.current) return;
    if (role === "member" || role === "committee" || role === "admin") {
      router.replace(next);
    } else if (role === "pending") {
      router.replace("/pending-approval");
    } else if (role === "rejected") {
      router.replace("/");
    }
  }, [authLoading, user, role, next, router, phase]);

  const onCredential = useCallback(
    async (idToken: string) => {
      credentialReceivedRef.current = true;
      setFormError(null);
      startSurge();
      try {
        const result = await exchangeGoogleCredential(idToken);
        if (result.isNew) {
          // Google sign-in with NO existing account (member or collaborator) —
          // works on /login too. Default them into joining as a UoN student/
          // staff member; honour an explicit collaborator choice if they picked
          // it on the register form. No "Model aligned" sweep — they still need
          // to register, not sign in. RegisterRouter takes over once `user` is
          // set and lands them on the right form (?type carries the audience,
          // since the in-place toggle's history.replaceState isn't observed by
          // the router).
          credentialReceivedRef.current = false;
          setPhase("idle");
          router.replace(
            mode === "register" && audience === "collaborator"
              ? "/register?type=collaborator"
              : "/register",
          );
          return;
        }
        // Existing account → success sweep + slide out, but only when the loader
        // is revealed; otherwise navigate straight away.
        await playSuccessSweep();
        try {
          sessionStorage.setItem("naisi:from-signin", "1");
        } catch {
          /* sessionStorage may be unavailable */
        }
        handledNavRef.current = true;
        if (loaderOpen) {
          setPhase("exiting");
          await sleep(EXIT_DURATION_MS);
        }
        router.push(next);
      } catch (err) {
        console.error(err);
        setFormError("Sign-in failed. Please try again.");
        credentialReceivedRef.current = false;
        setSuccessAt(null);
        setPhase("idle");
      }
    },
    [mode, audience, next, router, startSurge, playSuccessSweep, loaderOpen],
  );

  // Stable identity so GoogleSignInButton's init effect (keyed on onScriptError)
  // doesn't re-run on every keystroke — that was re-initialising GSI repeatedly.
  const onGoogleScriptError = useCallback((m: string) => setFormError(m), []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setResetNote(null);
      const trimmed = email.trim().toLowerCase();

      if (mode === "signin") {
        if (!trimmed || !password) {
          setFormError("Enter your email and password.");
          return;
        }
        setBusy(true);
        startSurge();
        try {
          const result = await signInWithEmailPassword(trimmed, password);
          handledNavRef.current = true;
          // Play the green alignment sweep + slide-out only if the loader's open;
          // otherwise navigate straight away (no invisible pause).
          await playSuccessSweep();
          if (loaderOpen) {
            setPhase("exiting");
            await sleep(EXIT_DURATION_MS);
          }
          if (result.kind === "collaborator") router.push("/collaborator");
          else if (result.kind === "member") router.push(next);
          else router.push("/register?type=collaborator");
        } catch (err) {
          setFormError(
            err instanceof Error ? err.message : "Sign-in failed. Please try again.",
          );
          setSuccessAt(null);
          setPhase("idle");
          setBusy(false);
        }
        return;
      }

      // register
      if (!trimmed || !password) {
        setFormError("Enter an email and a password.");
        return;
      }
      if (password.length < 6) {
        setFormError("Password must be at least 6 characters.");
        return;
      }
      if (password !== confirm) {
        setFormError("Those passwords don't match.");
        return;
      }
      setBusy(true);
      startSurge();
      try {
        const recaptchaToken = await getRecaptchaToken("register");
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: trimmed, password, audience, recaptchaToken }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string }
          | null;
        if (!res.ok) {
          setFormError(data?.error ?? "Couldn't create your account.");
          setSuccessAt(null);
          setPhase("idle");
          setBusy(false);
          return;
        }
        // Play the green alignment sweep, then reveal the check-inbox screen.
        await playSuccessSweep();
        setSentEmail(trimmed);
        setBusy(false);
      } catch {
        setFormError("Couldn't reach the server. Try again in a moment.");
        setSuccessAt(null);
        setPhase("idle");
        setBusy(false);
      }
    },
    [mode, email, password, confirm, audience, next, router, startSurge, playSuccessSweep, loaderOpen],
  );

  const handleReset = useCallback(async () => {
    setFormError(null);
    setResetNote(null);
    if (!email.trim()) {
      setFormError("Enter your email above first, then tap reset.");
      return;
    }
    try {
      await resetCollaboratorPassword(email.trim());
      setResetNote(
        "If an account exists for that email, a password reset link is on its way.",
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn't send a reset email.");
    }
  }, [email]);

  // The ambient "active inference" surge runs only while a field is focused:
  // focusing a field surges it, blurring calms it back to idle — unless a submit
  // is in flight or the success sweep is playing.
  const onFieldBlur = useCallback(() => {
    if (busy) return;
    setPhase((p) => (p === "active" ? "idle" : p));
  }, [busy]);

  const switchMode = useCallback(
    (m: Mode) => {
      if (m === mode) return;
      setMode(m);
      setFormError(null);
      setResetNote(null);
      setSentEmail(null);
      // Reset the loader if we're coming back from the post-submit success sweep
      // (e.g. "Log in here" off the check-inbox screen) so it can't sit frozen.
      setSuccessAt(null);
      setPhase("idle");
      // Keep the URL honest without a Next navigation (which would remount and
      // kill the morph).
      try {
        window.history.replaceState(
          null,
          "",
          m === "signin"
            ? "/login"
            : audience === "collaborator"
              ? "/register?type=collaborator"
              : "/register",
        );
      } catch {
        /* history unavailable */
      }
    },
    [mode, audience],
  );

  const switchAudience = useCallback(
    (a: RegisterAudience) => {
      if (a === audience) return;
      setAudience(a);
      try {
        window.history.replaceState(
          null,
          "",
          a === "collaborator" ? "/register?type=collaborator" : "/register",
        );
      } catch {
        /* history unavailable */
      }
    },
    [audience],
  );

  const frameClass = [
    signinStyles.exitFrame,
    entering ? signinStyles.entering : "",
    phase === "exiting" ? signinStyles.exiting : "",
    phase === "exitingBack" ? signinStyles.exitingBack : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Register check-inbox screen — uniform whether the email was new or already
  // registered (the server response is identical), so it leaks nothing.
  if (sentEmail) {
    return (
      <div className={`${frameClass} ${styles.frame}`}>
        <Card padding="lg" className={styles.card} style={{ width: "100%" }}>
          <h1 className={styles.heading}>Check your inbox</h1>
          <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-5)", lineHeight: 1.5 }}>
            If <strong>{sentEmail}</strong>{" "}
            <u>isn&apos;t already registered</u>, we&apos;ve sent it a link to
            confirm your email and finish signing up. Click it and you&apos;ll be
            brought right back here.
          </p>
          <ResendButton email={sentEmail} />
          <div style={{ marginTop: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              fullWidth
              onClick={() => switchMode("signin")}
            >
              Already have an account? Log in here
            </Button>
            <p style={{ color: "var(--color-text-subtle)", fontSize: "var(--text-sm)", textAlign: "center", margin: 0, lineHeight: 1.5 }}>
              No email is sent if you already have an account.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  // Mode-switch timing: slower than a snap, and SEQUENCED. The confirm-password
  // slot is offset into its own phase — it appears LAST going into register and
  // collapses FIRST coming out — so the rows aren't all moving at once. The other
  // rows (audience toggle, the form) wait that beat before settling on sign-in.
  const moveT = {
    duration: 0.45,
    ease: [0.22, 0.61, 0.36, 1] as const,
    delay: mode === "signin" ? 0.38 : 0,
  };
  const slotT = {
    duration: 0.45,
    ease: [0.22, 0.61, 0.36, 1] as const,
    delay: mode === "register" ? 0.38 : 0,
  };

  return (
    <div className={`${frameClass} ${styles.frame}`}>
      <Card padding="lg" className={styles.card} style={{ width: "100%" }}>
        <ModeToggle value={mode} onChange={switchMode} />

        <AnimatedText
          as="h1"
          className={styles.heading}
          style={{ minHeight: "1.25em" }}
          text={mode === "register" ? "Join NAISI" : "Welcome back"}
        />
        <AnimatedText
          style={{
            display: "block",
            color: "var(--color-text-muted)",
            lineHeight: 1.5,
            marginBottom: "var(--space-6)",
            minHeight: "2.8em",
          }}
          text={
            mode === "register"
              ? TAGLINE[audience]
              : "Sign in to access your dashboard, tasks, and course materials."
          }
        />

        {/* Audience toggle (register only) animates its own height; the rows
            below move via flow. On sign-in it waits the sequencing beat (moveT
            delay) so it collapses AFTER the confirm field has gone. */}
        <AnimatePresence initial={false}>
          {mode === "register" && (
            <motion.div
              key="audience"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={moveT}
              style={{ overflow: "hidden" }}
            >
              <RegisterAudienceToggle value={audience} onChange={switchAudience} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Always mounted — for every mode and audience (collaborators included).
            Keeping it stable is what stops GSI re-initialising on each render /
            mode switch. */}
        <div className={styles.googleWrap} onMouseDown={startSurge}>
          <GoogleSignInButton
            onCredential={onCredential}
            onScriptError={onGoogleScriptError}
            onReady={handleGisReady}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", margin: "var(--space-6) 0 var(--space-4)" }}>
          <span style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
          <span style={{ color: "var(--color-text-subtle)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            or
          </span>
          <span style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
        </div>

        <form id="auth-form" className={styles.authForm} onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div>
            <Field id="auth-email" label="Email">
              <Input
                id="auth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={startSurge}
                onMouseDown={startSurge}
                onBlur={onFieldBlur}
                autoComplete="email"
                placeholder={mode === "register" ? "you@gmail.com" : "you@example.com"}
                required
              />
            </Field>
            {/* Hint space is REVEALED (height-animated) rather than added
                instantly, so the rows below don't jump. */}
            <AnimatePresence initial={false}>
              {mode === "register" && (
                <motion.div
                  key="email-hint"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={moveT}
                  style={{ overflow: "hidden" }}
                >
                  <p style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
                    Use a personal email you&apos;ll keep — not a university
                    address. You&apos;ll confirm any university affiliation
                    separately.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div>
            <Field id="auth-password" label="Password">
              <PasswordInput
                id="auth-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={startSurge}
                onMouseDown={startSurge}
                onBlur={onFieldBlur}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
              />
            </Field>
            <AnimatePresence initial={false}>
              {mode === "register" && (
                <motion.div
                  key="password-hint"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={moveT}
                  style={{ overflow: "hidden" }}
                >
                  <p style={{ marginTop: "var(--space-2)", fontSize: "var(--text-sm)", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
                    At least 6 characters.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {/* Confirm-password (register) / Forgot-password (sign in) share one
              slot. SEQUENCED via slotT: going INTO register the height expands
              last (after the rest); coming OUT it collapses first. The inner
              content fades on swap. */}
          <motion.div layout transition={slotT} style={{ overflow: "hidden" }}>
            <motion.div
              key={mode}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.34,
                ease: [0.22, 0.61, 0.36, 1],
                // Float the content UP into place, and hold it until the rows
                // have finished moving (forgot-password waits the longest, so it
                // doesn't pop in then get shoved up as the password rises).
                delay: mode === "signin" ? 0.8 : 0.42,
              }}
            >
              {mode === "register" ? (
                <Field id="auth-confirm" label="Confirm password">
                  <PasswordInput
                    id="auth-confirm"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    onFocus={startSurge}
                    onMouseDown={startSurge}
                    onBlur={onFieldBlur}
                    autoComplete="new-password"
                    required
                  />
                </Field>
              ) : (
                <div style={{ display: "flex", justifyContent: "center", paddingTop: "var(--space-1)" }}>
                  <button
                    type="button"
                    onClick={() => void handleReset()}
                    style={{ background: "none", border: "none", color: "var(--color-text-muted)", fontSize: "var(--text-xs)", cursor: "pointer", textDecoration: "underline" }}
                  >
                    Forgot password?
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
          {formError && (
            <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{formError}</p>
          )}
          {resetNote && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>{resetNote}</p>
          )}
        </form>

        <div className={styles.footer}>
          {/* Mobile-only: the bar's top edge as a smooth accent line that bumps
              up and around the chevron tab (drawn on top of the feather). */}
          <svg
            className={styles.barEdge}
            viewBox="0 0 200 30"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              className={styles.barEdgeFill}
              d="M0 30 L0 28 L78 28 C88 28 88 5 96 5 L104 5 C112 5 112 28 122 28 L200 28 L200 30 Z"
            />
            <path
              className={styles.barEdgeStroke}
              d="M0 28 L78 28 C88 28 88 5 96 5 L104 5 C112 5 112 28 122 28 L200 28"
              vectorEffect="non-scaling-stroke"
              strokeWidth="1.25"
            />
          </svg>
          <button
            type="button"
            className={styles.loaderHandle}
            onClick={() => setLoaderOpen((o) => !o)}
            aria-expanded={loaderOpen}
            aria-label={loaderOpen ? "Hide the sign-in animation" : "Show the sign-in animation"}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              aria-hidden="true"
              style={{ transition: "transform 0.3s ease", transform: loaderOpen ? "rotate(180deg)" : "none" }}
            >
              <path d="M7 14.5 L12 9.5 L17 14.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <AnimatePresence initial={false}>
            {loaderOpen && (
              <motion.div
                key="loader"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={LAYOUT_T}
                style={{ overflow: "hidden" }}
              >
                {/* Gap lives on an INNER element so it's part of the animated
                    auto-height (collapses fully to 0). On the collapsing element
                    itself, padding can't shrink — the bar would stall at the
                    padding height then snap. */}
                <div style={{ paddingBottom: "var(--space-3)" }}>
                  <SigningIn
                    active={phase !== "idle"}
                    successStartAt={phase === "success" || phase === "exiting" ? successAt : null}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Button type="submit" form="auth-form" fullWidth size="lg" disabled={busy}>
            {mode === "register"
              ? busy
                ? "Creating account…"
                : "Create account & continue"
              : busy
                ? "Signing in…"
                : "Sign in"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Sign in ↔ Create account — sliding-pill toggle (shared-layout `motion.span`). */
function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const opts: { v: Mode; label: string }[] = [
    { v: "register", label: "Create account" },
    { v: "signin", label: "Sign in" },
  ];
  return (
    <div style={{ textAlign: "center", marginBottom: "var(--space-5)" }}>
      <div
        role="radiogroup"
        aria-label="Sign in or create an account"
        style={{ display: "inline-flex", position: "relative", padding: "3px", gap: "3px", background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}
      >
        {opts.map((o) => {
          const active = o.v === value;
          return (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.v)}
              style={{ position: "relative", appearance: "none", background: "transparent", border: "none", cursor: "pointer", padding: "0.4rem 0.9rem", fontSize: "var(--text-sm)", fontWeight: 500, color: active ? "white" : "var(--color-text-muted)", borderRadius: "calc(var(--radius-md) - 3px)", transition: "color var(--transition-fast)", whiteSpace: "nowrap" }}
            >
              {active && (
                <motion.span
                  layoutId="auth-mode-pill"
                  aria-hidden="true"
                  style={{ position: "absolute", inset: 0, background: "var(--color-accent)", borderRadius: "calc(var(--radius-md) - 3px)", zIndex: 0 }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span style={{ position: "relative", zIndex: 1 }}>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 60s progress-bar resend for the check-inbox screen. */
function ResendButton({ email }: { email: string }) {
  // Track sub-second remaining time (ticked ~16×/s) so the fill bar slides
  // continuously left→right rather than jumping per whole second.
  const [remainingMs, setRemainingMs] = useState(RESEND_COOLDOWN_SECONDS * 1000);
  const [busy, setBusy] = useState(false);
  const targetRef = useRef(0);

  useEffect(() => {
    targetRef.current = Date.now() + RESEND_COOLDOWN_SECONDS * 1000;
    const id = setInterval(() => {
      setRemainingMs(Math.max(0, targetRef.current - Date.now()));
    }, 60);
    return () => clearInterval(id);
  }, []);

  const onResend = useCallback(async () => {
    if (remainingMs > 0 || busy) return;
    setBusy(true);
    try {
      const recaptchaToken = await getRecaptchaToken("resend");
      await fetch("/api/register/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, recaptchaToken }),
      });
    } catch {
      /* uniform response anyway */
    }
    targetRef.current = Date.now() + RESEND_COOLDOWN_SECONDS * 1000;
    setRemainingMs(RESEND_COOLDOWN_SECONDS * 1000);
    setBusy(false);
  }, [email, remainingMs, busy]);

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const disabled = remainingMs > 0 || busy;
  const pct = Math.min(100, (1 - remainingMs / (RESEND_COOLDOWN_SECONDS * 1000)) * 100);

  return (
    <button
      type="button"
      onClick={() => void onResend()}
      disabled={disabled}
      style={{ position: "relative", overflow: "hidden", width: "100%", padding: "var(--space-3)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-bg-elevated)", color: disabled ? "var(--color-text-muted)" : "var(--color-accent)", fontSize: "var(--text-sm)", fontWeight: 500, cursor: disabled ? "default" : "pointer" }}
    >
      <span
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, transformOrigin: "left", transform: `scaleX(${pct / 100})`, background: "var(--color-surface-hover)", transition: "transform 90ms linear", zIndex: 0 }}
      />
      <span style={{ position: "relative", zIndex: 1 }}>
        {disabled ? `Resend email in ${secondsLeft}s` : "Resend email"}
      </span>
    </button>
  );
}

