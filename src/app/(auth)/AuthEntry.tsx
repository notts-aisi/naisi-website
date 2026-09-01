"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import SigningIn from "@/components/SigningIn";
import signinStyles from "@/components/SigningIn.module.css";
import styles from "./register/registerSignIn.module.css";
import { mark, warn } from "@/lib/devMonitor";
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
import { hardNavigate } from "@/lib/navigation/hardNavigate";
import { claimSelfHealAttempt } from "@/lib/navigation/selfHealGuard";
import { minWidth } from "@/theme/breakpoints";
import {
  RecaptchaInvisible,
  RECAPTCHA_ENABLED,
  type RecaptchaHandle,
} from "@/components/ui/RecaptchaInvisible";

type Mode = "signin" | "register";
type SignInPhase = "idle" | "active" | "navigating" | "exitingBack";

const EXIT_DURATION_MS = 530;
// How long after a refocus (popup dismissed?) before the surge calms back to
// idle. Generous because the GIS credential routinely lands well after focus
// returns on a slow connection — with the loader visible by default, a
// premature reset reads as a "gave up" flicker mid-sign-in.
const CANCEL_GRACE_MS = 2500;
const RESEND_COOLDOWN_SECONDS = 60;
// Resolves after the browser has painted the current frame (double rAF) — lets
// the handoff pane reach the screen before the document starts unloading.
const nextPaint = () =>
  new Promise<void>((res) =>
    requestAnimationFrame(() => requestAnimationFrame(() => res())),
  );
// Mirrors naisi.sidebar.collapsed: localStorage, not cookies, to sidestep PECR
// preference-cookie ambiguity.
const LOADER_OPEN_KEY = "naisi.auth.loaderOpen";
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
 * surge choreography is shared. Registration submits to the enumeration-safe
 * server route and shows the uniform "check your inbox" screen.
 */
export default function AuthEntry({ initialMode }: { initialMode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";
  // Guard every post-auth redirect against open-redirect: only ever navigate to a
  // same-origin path, never an absolute URL or a protocol-relative //evil.com.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const { user, role, loading: authLoading } = useAuth();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [audience, setAudience] = useState<RegisterAudience>(
    params.get("type") === "collaborator" ? "collaborator" : "member",
  );
  // The ambient/sign-in animation. Open by default on md+ viewports so the
  // sign-in choreography is always visible; closed by default on phones, where
  // the bar it lives in is bottom-stuck and the viewport is zoom-locked
  // (AuthBodyLock), so the extra height would squeeze the fields against the
  // keyboard. The chevron persists an explicit choice either way. Starts false
  // on both server and client render, then the pre-paint effect below applies
  // the stored/derived value — SSR markup can't know the viewport, and this
  // keeps hydration mismatch-free.
  const [loaderOpen, setLoaderOpen] = useState(false);
  useLayoutEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LOADER_OPEN_KEY);
    } catch {
      /* storage unavailable */
    }
    if (stored === "1" || stored === "0") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-paint init from storage
      setLoaderOpen(stored === "1");
      return;
    }
    try {
      if (window.matchMedia(minWidth("md")).matches) setLoaderOpen(true);
    } catch {
      /* matchMedia unavailable */
    }
  }, []);
  const [phase, setPhase] = useState<SignInPhase>("idle");
  // Destination of an in-flight post-sign-in navigation; non-null renders the
  // full-viewport handoff pane.
  const [navDest, setNavDest] = useState<string | null>(null);
  const [entering, setEntering] = useState(true);
  const credentialReceivedRef = useRef(false);
  const handledNavRef = useRef(false);
  const mintingRef = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Google credential exchange in flight — greys the GIS button, blocks a
  // second click, and shows the ring beside it.
  const [googleBusy, setGoogleBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  // reCAPTCHA v2 Invisible — driven imperatively on submit (no visible widget).
  const recaptchaRef = useRef<RecaptchaHandle>(null);

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
      if (phase === "navigating" || phase === "exitingBack") return;
      e.preventDefault();
      setPhase("exitingBack");
      handledNavRef.current = true;
      setTimeout(() => router.push("/"), EXIT_DURATION_MS);
    };
    window.addEventListener(AUTH_BACK_HOME_EVENT, onBack);
    return () => window.removeEventListener(AUTH_BACK_HOME_EVENT, onBack);
  }, [phase, router]);

  const startSurge = useCallback(() => {
    setPhase((p) => (p === "idle" ? "active" : p));
  }, []);

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
        // Functional update — the closure's `phase` is stale by the time the
        // grace elapses if a submit started in the meantime.
        if (!credentialReceivedRef.current) {
          setPhase((p) => (p === "active" ? "idle" : p));
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

  // Already signed in on a passive page load? Re-mint the server session cookie,
  // THEN bounce away. The client can hold a live Firebase Auth session while the
  // httpOnly __session cookie is missing or expired (cleared cookies, an idle
  // longer than the cookie lifetime, a deploy). Navigating straight to a gated
  // route then bounces back to /login on the SERVER cookie check, this effect
  // fires again, and the user is stuck in a /login redirect loop. Minting a fresh
  // cookie from the current idToken first turns that loop into a one-round-trip
  // self-heal.
  //
  // We mint FIRST and let the route's returned `kind` decide the destination,
  // because role can be null for two different reasons: a collaborator (no users
  // doc, so AuthProvider never resolves a role) — the OTHER account type that
  // hits this loop — or a members-doc snapshot that simply hasn't arrived yet.
  //
  // Guards: `phase !== "idle"` + `credentialReceivedRef` mean this never runs
  // mid-sign-in (those interactive paths mint their own cookie and navigate);
  // `mintingRef` stops a re-render from starting a second mint; `handledNavRef`
  // is only set once we actually navigate, so a not-yet-routable null role can
  // still be picked up when it resolves.
  useEffect(() => {
    if (authLoading || !user) return;
    if (phase !== "idle") return;
    if (handledNavRef.current || mintingRef.current) return;
    if (credentialReceivedRef.current) return; // an interactive sign-in is driving

    const knownDest =
      role === "member" || role === "committee" || role === "admin"
        ? safeNext
        : role === "pending"
          ? "/pending-approval"
          : role === "rejected"
            ? "/"
            : null;

    mintingRef.current = true;
    void (async () => {
      let kind: string | null = null;
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        kind =
          ((await res.json().catch(() => null)) as { kind?: string } | null)?.kind ??
          null;
      } catch {
        // Best-effort: a fake dev-bypass user (no real getIdToken) or a network
        // failure lands here. We fall back to knownDest only.
      }
      // Prefer the resolved member-side role; otherwise route on the server's
      // account kind (collaborator → their area; member = users doc exists but the
      // snapshot is just lagging → honour `next`). kind "new"/unknown with a null
      // role means no completed account, so we don't navigate — the registration
      // flow handles them, and a later role resolution re-fires this effect.
      const dest =
        knownDest ??
        (kind === "collaborator"
          ? "/collaborator"
          : kind === "member"
            ? safeNext
            : null);
      if (dest) {
        handledNavRef.current = true;
        // Hard nav, not router.replace. We are sitting on /login precisely
        // BECAUSE `dest` redirected here — proxy.ts:34-37 on a missing cookie,
        // or an (app)/layout.tsx gate — so this document's route cache maps
        // dest -> /login and a soft replace replays that redirect with no
        // network request at all. See lib/navigation/hardNavigate.ts for the
        // Next-internals detail; a document load is the only thing that
        // clears it.
        //
        // The guard matters because the reload ALSO resets handledNavRef: if
        // the mint 200s but the cookie never sticks, an unguarded hard nav
        // loops the page forever. A second attempt inside the window surfaces
        // an error instead.
        if (claimSelfHealAttempt()) {
          // Leave mintingRef latched — the document is going away. The
          // `return` is load-bearing: window.location.replace does NOT halt
          // execution, so without it the line below unlatches mintingRef and
          // a re-render could start a second mint during teardown.
          hardNavigate(dest, "replace");
          return;
        }
        setFormError("We couldn't restore your session. Please sign in again.");
      }
      mintingRef.current = false;
    })();
  }, [authLoading, user, role, safeNext, phase]);

  /*
   * Redirect-mode return leg, part 1: the latch. On phones and installed
   * apps the Google button navigates to Google, which POSTs the credential
   * to /api/auth/google/callback; that route verifies it and lands back
   * here with the token in a short-lived single-use cookie. The consume
   * effect lives below onCredential (it calls it directly); this ref stops
   * a Strict Mode double-invoke or an identity-keyed re-run from consuming
   * twice. Mirrored constants: the cookie names live in the route file.
   */
  const redirectConsumedRef = useRef(false);

  /*
   * Stash ?next= so it survives the redirect round trip through Google (GIS
   * redirect mode carries no state). The callback route reads this cookie,
   * re-applies the open-redirect guard server-side, and puts next back on
   * the /login URL it redirects to.
   */
  useEffect(() => {
    if (!params.get("next")) return;
    try {
      document.cookie = `__auth_next=${encodeURIComponent(safeNext)}; path=/; max-age=600; samesite=lax`;
    } catch {
      /* fine: the user just lands on /dashboard instead */
    }
  }, [params, safeNext]);

  /* Surface a redirect-leg failure. The google_error values are set by the
     callback route; csrf-cookie-missing is the diagnostic one for installed
     iOS apps (see the route's docblock). */
  useEffect(() => {
    const err = params.get("google_error");
    if (!err) return;
    warn("[signin] google redirect leg failed", { err });
    // Reacting to a URL param the server callback set: same shape as the
    // close-on-pathname effects elsewhere in the codebase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFormError(
      "Google sign-in could not be completed. Try again, or use your email and password.",
    );
  }, [params]);

  const onCredential = useCallback(
    async (idToken: string) => {
      credentialReceivedRef.current = true;
      setGoogleBusy(true);
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
        // Existing account → straight to the handoff pane, which owns the
        // screen while the document loads. Collaborators have no users doc
        // (the server resolves them via `kind`), so send them to their own
        // area — this path used to bounce them to /register as if brand new.
        const dest = result.kind === "collaborator" ? "/collaborator" : safeNext;
        try {
          sessionStorage.setItem("naisi:from-signin", "1");
        } catch {
          /* sessionStorage may be unavailable */
        }
        handledNavRef.current = true;
        setNavDest(dest);
        setPhase("navigating");
        // Let the pane reach the screen before the document starts unloading —
        // it is what the user watches until the destination paints, so there is
        // never a bare dark gap (the card no longer slides out to nothing).
        await nextPaint();
        // Hard nav: `safeNext` comes from ?next=, which is only ever populated
        // by proxy.ts:36 — so its presence is direct evidence that a protected
        // route already redirected in this document and left a poisoned route
        // cache entry behind. "naisi:from-signin" is sessionStorage, which
        // survives the document load, so AppShell still plays the entering fade.
        hardNavigate(dest);
      } catch (err) {
        console.error(err);
        setFormError("Sign-in failed. Please try again.");
        credentialReceivedRef.current = false;
        setGoogleBusy(false);
        setPhase("idle");
      }
    },
    [mode, audience, safeNext, router, startSurge],
  );

  /*
   * Redirect-mode return leg, part 2: consume the credential the callback
   * route left in a cookie and feed it to the SAME onCredential path popup
   * mode uses, so everything downstream is one code path.
   *
   * Keyed on onCredential's identity, which changes across renders; that is
   * safe because the cookie is deleted before use and the ref latches, so
   * re-runs consume nothing. Declared after onCredential because it calls it
   * directly.
   */
  useEffect(() => {
    if (redirectConsumedRef.current) return;
    let credential: string | null = null;
    try {
      const m = document.cookie.match(/(?:^|; )__google_credential=([^;]*)/);
      if (!m || !m[1]) return;
      redirectConsumedRef.current = true;
      credential = decodeURIComponent(m[1]);
      document.cookie = "__google_credential=; path=/login; max-age=0";
    } catch {
      return; /* cookie access unavailable; nothing to consume */
    }
    mark("[signin] consuming redirect-mode credential");
    // Deferred a tick: onCredential's synchronous prologue sets state, and
    // kicking it off outside the effect body keeps the effect itself pure
    // (and satisfies the set-state-in-effect lint honestly rather than
    // suppressing it).
    const t = setTimeout(() => void onCredential(credential as string), 0);
    return () => clearTimeout(t);
  }, [onCredential]);

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
          // Parity with the Google path above — this branch never set the flag,
          // so email/password sign-in has always jump-cut into the shell.
          try {
            sessionStorage.setItem("naisi:from-signin", "1");
          } catch {
            /* sessionStorage may be unavailable */
          }
          // Hard nav for the two protected destinations (both are in
          // proxy.ts's PROTECTED_PREFIXES, so both can be poisoned), fronted by
          // the handoff pane. /register is neither protected nor a redirect
          // target, so nothing can have been recorded against it — it stays a
          // soft push with no pane.
          if (result.kind === "collaborator" || result.kind === "member") {
            const dest =
              result.kind === "collaborator" ? "/collaborator" : safeNext;
            setNavDest(dest);
            setPhase("navigating");
            await nextPaint();
            hardNavigate(dest);
          } else {
            router.push("/register?type=collaborator");
          }
        } catch (err) {
          setFormError(
            err instanceof Error ? err.message : "Sign-in failed. Please try again.",
          );
          setPhase("idle");
          setBusy(false);
        }
        return;
      }

      // register — EMAIL ONLY. The password is set after the email is verified
      // (the account is created server-side with a random throwaway password).
      if (!trimmed) {
        setFormError("Enter your email.");
        return;
      }
      setBusy(true);
      startSurge();
      try {
        // Invisible challenge — resolves silently for a trusted user, or after a
        // popup for a flagged one. Null = unconfigured (skip) or dismissed/failed.
        const recaptchaToken = await (recaptchaRef.current?.execute() ?? Promise.resolve(null));
        if (RECAPTCHA_ENABLED && !recaptchaToken) {
          setFormError("Couldn't verify you're human. Please try again.");
          setPhase("idle");
          setBusy(false);
          return;
        }
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: trimmed, audience, recaptchaToken }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string }
          | null;
        if (!res.ok) {
          setFormError(data?.error ?? "Couldn't create your account.");
          setPhase("idle");
          setBusy(false);
          return;
        }
        setSentEmail(trimmed);
        setBusy(false);
      } catch {
        setFormError("Couldn't reach the server. Try again in a moment.");
        setPhase("idle");
        setBusy(false);
      }
    },
    [mode, email, password, audience, safeNext, router, startSurge],
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
  // is in flight.
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

  // No "exiting" class any more: on a hard navigation the card stays put and
  // the handoff pane covers it, so there is never a bare viewport mid-load.
  const frameClass = [
    signinStyles.exitFrame,
    entering ? signinStyles.entering : "",
    phase === "exitingBack" ? signinStyles.exitingBack : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Register check-inbox screen — uniform whether the email was new or already
  // registered (the server response is identical), so it leaks nothing.
  if (sentEmail) {
    return (
      <div className={`${frameClass} ${styles.frame}`}>
        {/* Ease the check-inbox card in rather than hard-swapping from the form —
            the submit pause (server-side email send) makes an instant pop jarring. */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 0.61, 0.36, 1] }}
          style={{ width: "100%" }}
        >
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
        </motion.div>
      </div>
    );
  }

  // Mode-switch timing: slower than a snap, and SEQUENCED so the rows aren't all
  // moving at once (the password block waits this beat before settling on sign-in).
  const moveT = {
    duration: 0.45,
    ease: [0.22, 0.61, 0.36, 1] as const,
    delay: mode === "signin" ? 0.38 : 0,
  };

  return (
    <>
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
        <div
          className={
            googleBusy ? `${styles.googleWrap} ${styles.googleWrapBusy}` : styles.googleWrap
          }
          onMouseDown={startSurge}
          aria-busy={googleBusy}
        >
          <GoogleSignInButton
            onCredential={onCredential}
            onScriptError={onGoogleScriptError}
            onReady={handleGisReady}
          />
          {googleBusy && <span className={styles.googleSpinner} aria-hidden="true" />}
        </div>
        {/*
          Always rendered, hidden by CSS unless <html data-standalone-ios>.
          Doing it in CSS rather than behind useIsStandalone keeps the server
          HTML identical for everyone and means no flash on the first screen
          of a freshly launched app. The stylesheet also reorders this card so
          the email and password form comes FIRST in that case; see the
          "Installed app on iOS" block in registerSignIn.module.css.
        */}
        <p className={styles.standaloneNote}>
          Google sign-in opens a secure Google page and returns here. If it
          does not complete, use your email and password above, or open
          naisi.uk in Safari.
        </p>
        <div className={styles.divider} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", margin: "var(--space-6) 0 var(--space-4)" }}>
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
          {/* Password + "Forgot password?" — SIGN-IN only. Register is email-only
              (the password is set after the email is verified), so the whole block
              height-collapses on register and the form stays compact. */}
          <AnimatePresence initial={false}>
            {mode === "signin" && (
              <motion.div
                key="password-block"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={moveT}
                style={{ overflow: "hidden" }}
              >
                <Field id="auth-password" label="Password">
                  <PasswordInput
                    id="auth-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={startSurge}
                    onMouseDown={startSurge}
                    onBlur={onFieldBlur}
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <div style={{ display: "flex", justifyContent: "center", paddingTop: "var(--space-2)" }}>
                  <button
                    type="button"
                    onClick={() => void handleReset()}
                    style={{ background: "none", border: "none", color: "var(--color-text-muted)", fontSize: "var(--text-xs)", cursor: "pointer", textDecoration: "underline" }}
                  >
                    Forgot password?
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {formError && (
            <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{formError}</p>
          )}
          {resetNote && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>{resetNote}</p>
          )}
          {/* Invisible reCAPTCHA — register only (keeps the floating badge off the
              sign-in screen). No layout footprint; driven via the ref on submit. */}
          {mode === "register" && RECAPTCHA_ENABLED && (
            <RecaptchaInvisible ref={recaptchaRef} />
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
            onClick={() => {
              const next = !loaderOpen;
              try {
                localStorage.setItem(LOADER_OPEN_KEY, next ? "1" : "0");
              } catch {
                /* storage unavailable */
              }
              setLoaderOpen(next);
            }}
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
                  <SigningIn active={phase !== "idle"} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Button type="submit" form="auth-form" fullWidth size="lg" disabled={busy}>
            {mode === "register"
              ? busy
                ? "Sending…"
                : "Continue with email"
              : busy
                ? "Signing in…"
                : "Sign in"}
          </Button>
        </div>
      </Card>
    </div>
    {navDest !== null && <NavigatingPane dest={navDest} />}
    </>
  );
}

/**
 * Full-viewport handoff pane shown from the moment sign-in succeeds until the
 * destination document paints. Replaces the old card slide-out, which left a
 * bare #050810 viewport for the whole document load — the pane owns that
 * window with an explicit "signed in, on our way" surface instead. If the
 * navigation never lands (hung request, dropped connection), a retry appears
 * after 8s so nobody is stranded staring at it.
 *
 * Rendered OUTSIDE the exit frame: the frame carries transforms in some
 * phases, and a transformed ancestor would turn `position: fixed` into
 * ancestor-relative positioning.
 */
function NavigatingPane({ dest }: { dest: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div
      className={styles.navPane}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.26, ease: "easeOut" }}
    >
      <div className={styles.navPaneRow}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="10.5"
            fill="hsla(142, 70%, 50%, 0.18)"
            stroke="hsla(142, 80%, 62%, 0.9)"
            strokeWidth="1.4"
          />
          <path
            d="M7 12.5 L10.5 16 L17 9"
            stroke="hsla(142, 92%, 80%, 1)"
            strokeWidth="2.2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className={styles.navPaneTitle}>Signed in</span>
      </div>
      <p className={styles.navPaneText} role="status">
        {dest.startsWith("/collaborator")
          ? "Taking you to your workspace…"
          : "Taking you to your dashboard…"}
      </p>
      <div className={styles.navPaneBar} aria-hidden="true">
        <span className={styles.navPaneBarFill} />
      </div>
      {slow && (
        <div className={styles.navPaneSlow}>
          <p className={styles.navPaneSlowText}>Taking longer than it should?</p>
          <Button type="button" variant="secondary" onClick={() => hardNavigate(dest)}>
            Try again
          </Button>
        </div>
      )}
    </motion.div>
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
      // No reCAPTCHA here: the resend is already 60s-cooldown-gated and only ever
      // re-sends to a genuine pending registration — a second invisible widget on
      // the check-inbox screen isn't worth the wiring.
      await fetch("/api/register/resend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
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

