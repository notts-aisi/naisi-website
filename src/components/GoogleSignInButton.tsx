"use client";

import { useEffect, useRef, useState } from "react";
import { mark, warn } from "@/lib/devMonitor";
import styles from "./GoogleSignInButton.module.css";

type Props = {
  /** Receives the Google-issued ID token. The caller hands it to Firebase
   *  via GoogleAuthProvider.credential(idToken) → signInWithCredential. */
  onCredential: (idToken: string) => void;
  /** Called when Google sign-in cannot proceed, with a message the caller
   *  should show the user. Two causes, both of which fail silently otherwise,
   *  and silent failure was the original bug that made this flow
   *  user-hostile:
   *
   *    1. GIS fails to load (almost always a content blocker or VPN blocking
   *       accounts.google.com/gsi/client).
   *    2. GIS loads but its sign-in popup is refused. See the window.open
   *       watch below for why that cannot be observed any other way.
   *
   *  The name is kept for the sake of its two existing call sites; read it
   *  as "sign-in is unavailable, here is why" rather than strictly "the
   *  script failed". */
  onScriptError?: (reason: string) => void;
  /** Called once the GIS button has finished rendering and is interactive.
   *  Used by the login page to gate its swipe-in entrance — the card stays
   *  off-screen until the Google button is genuinely ready so users don't
   *  see the "Loading sign-in…" placeholder. */
  onReady?: () => void;
};

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
// How long to wait for window.google to appear before declaring the
// script blocked. Chrome on a fast connection loads it in ~200ms; we
// give 5s to cover slow networks and slow re-mounts. Beyond that it's
// almost certainly a content blocker.
const SCRIPT_LOAD_TIMEOUT_MS = 5000;

export default function GoogleSignInButton({
  onCredential,
  onScriptError,
  onReady,
}: Props) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  // Latest onCredential in a ref so the GIS callback registered with
  // initialize() always calls the current handler — without it,
  // initialize captures the first onCredential and stale-closures any
  // updates (state-dependent routing logic in the caller wouldn't see
  // current state).
  const onCredentialRef = useRef(onCredential);
  const onReadyRef = useRef(onReady);
  const onScriptErrorRef = useRef(onScriptError);
  useEffect(() => {
    onCredentialRef.current = onCredential;
    onReadyRef.current = onReady;
    onScriptErrorRef.current = onScriptError;
  });

  /*
   * Detect a refused sign-in popup.
   *
   * This cannot be done the obvious way. renderButton() draws Google's button
   * inside a cross-origin iframe, so the tap never reaches our code and there
   * is no click handler to hang a check on. What IS observable is that the
   * gsi/client script calls window.open from the TOP document, so wrapping it
   * catches the refusal.
   *
   * The case that matters: inside an installed iOS home-screen app,
   * window.open returns null and opens nothing (documented by Google on
   * web.dev). GIS logs a popup failure to the console and its credential
   * callback never fires, so without this the tap is a completely silent dead
   * end and the user is left staring at a button that appears to do nothing.
   * The same wrapper also catches an ordinary desktop popup blocker.
   *
   * Scoped to accounts.google.com so an unrelated blocked popup elsewhere on
   * the page cannot produce a misleading sign-in error, and reported at most
   * once so repeated taps do not stack messages. The original is restored on
   * unmount, and only if it is still ours, so a wrapper installed after this
   * one is not clobbered.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const original = window.open;
    let reported = false;

    const wrapped: typeof window.open = (url, target, features) => {
      const opened = original.call(window, url, target, features);
      const href = typeof url === "string" ? url : (url?.toString() ?? "");
      if (!opened && !reported && href.includes("accounts.google.com")) {
        reported = true;
        warn("[gsi] window.open refused — popup blocked or unavailable", { href });
        onScriptErrorRef.current?.(
          "Google sign-in could not open its sign-in window. If you are using NAISI from your home screen, sign in with your email and password instead. In a browser, check whether a pop-up blocker is active.",
        );
      }
      return opened;
    };

    window.open = wrapped;
    return () => {
      if (window.open === wrapped) window.open = original;
    };
  }, []);

  // A missing client id is a build-time misconfiguration, so the button
  // can start in the error state instead of flashing "Loading sign-in…".
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    CLIENT_ID ? "loading" : "error",
  );

  useEffect(() => {
    if (!CLIENT_ID) {
      warn("[gsi] NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset — button cannot render");
      onScriptError?.("Sign-in is misconfigured. Please contact support.");
      onReadyRef.current?.();
      return;
    }

    let cancelled = false;
    const startedAt = performance.now();

    function tryInit() {
      if (cancelled) return;
      if (!window.google?.accounts?.id) {
        if (performance.now() - startedAt > SCRIPT_LOAD_TIMEOUT_MS) {
          warn("[gsi] script never loaded — likely a content blocker");
          onScriptError?.(
            "Sign-in couldn't load. A content blocker, ad-blocker, or VPN tracking-protection may be blocking Google's services. Try disabling those for this site, or use a different browser.",
          );
          setStatus("error");
          onReadyRef.current?.();
          return;
        }
        // Poll — next/script's `afterInteractive` strategy doesn't
        // expose a load promise we can await, so we poll every 50ms
        // until window.google appears.
        setTimeout(tryInit, 50);
        return;
      }

      mark("[gsi] script loaded, initializing");
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID!,
        callback: (res) => {
          mark("[gsi] credential received", { select_by: res.select_by });
          onCredentialRef.current(res.credential);
        },
        auto_select: false,
        cancel_on_tap_outside: true,
        // Critical for Safari: enables GIS's ITP-aware persistence strategy
        // so the credential flow doesn't depend on third-party storage
        // access the browser would partition.
        itp_support: true,
        ux_mode: "popup",
        context: "signin",
      });

      if (buttonRef.current) {
        // Renders Google's branded button into our div. We can't deeply
        // restyle it (Google's TOS) — only their official theme variants
        // are allowed. `filled_blue` matches our accent colour. The
        // white wrapper background GSI injects around the pill is
        // stripped by GoogleSignInButton.module.css. width is in px;
        // we fix at 320 so the button feels prominent on the card.
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "filled_blue",
          size: "large",
          shape: "pill",
          text: "continue_with",
          logo_alignment: "left",
          width: 320,
        });
      }

      // GIS's iframe initially renders the generic "Continue with Google"
      // button, then — for users with an active Google session — re-renders
      // ~200-500ms later as the personalised "Continue as [Name]" with the
      // user's photo. There's no public config to suppress this. Instead
      // we keep the wrapper opacity:0 (via the `loading` state below) for
      // 700ms after renderButton so the user sees a STABLE final button
      // when it reveals, not the mid-flight personalisation re-render.
      const PERSONALISATION_SETTLE_MS = 700;
      setTimeout(() => {
        if (cancelled) return;
        setStatus("ready");
        onReadyRef.current?.();
      }, PERSONALISATION_SETTLE_MS);
    }

    tryInit();

    return () => {
      cancelled = true;
    };
  }, [onScriptError]);

  return (
    <div className={styles.container}>
      <div
        ref={buttonRef}
        className={`${styles.wrapper} ${status === "ready" ? styles.wrapperReady : ""}`}
        aria-hidden={status !== "ready"}
      />
      {status === "loading" && (
        <p className={styles.loadingMessage}>Loading sign-in…</p>
      )}
    </div>
  );
}
