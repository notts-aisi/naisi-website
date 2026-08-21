"use client";

import { useEffect, useRef, useState } from "react";
import { mark, warn } from "@/lib/devMonitor";
import styles from "./GoogleSignInButton.module.css";

type Props = {
  /** Receives the Google-issued ID token. The caller hands it to Firebase
   *  via GoogleAuthProvider.credential(idToken) → signInWithCredential. */
  onCredential: (idToken: string) => void;
  /** Called when GIS fails to load (almost always: content blocker / VPN
   *  blocking accounts.google.com/gsi/client). The caller should surface
   *  an actionable error message — silent failure was the original bug
   *  that made this whole flow user-hostile. */
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
  useEffect(() => {
    onCredentialRef.current = onCredential;
    onReadyRef.current = onReady;
  });

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
