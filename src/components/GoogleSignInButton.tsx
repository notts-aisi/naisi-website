"use client";

import { useEffect, useRef, useState } from "react";
import { mark, warn } from "@/lib/devMonitor";

type Props = {
  /** Receives the Google-issued ID token. The caller hands it to Firebase
   *  via GoogleAuthProvider.credential(idToken) → signInWithCredential. */
  onCredential: (idToken: string) => void;
  /** Called when GIS fails to load (almost always: content blocker / VPN
   *  blocking accounts.google.com/gsi/client). The caller should surface
   *  an actionable error message — silent failure was the original bug
   *  that made this whole flow user-hostile. */
  onScriptError?: (reason: string) => void;
  /** Show the One Tap auto-prompt card alongside the button. Returning
   *  users who've already signed in once see a top-right card that
   *  completes sign-in in a single click. Default true on /login, false
   *  on /register (a new user clicking "Continue with Google" shouldn't
   *  be hijacked by One Tap auto-signing them into an unintended account). */
  showOneTap?: boolean;
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
  showOneTap = true,
}: Props) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  // Latest onCredential in a ref so the GIS callback registered with
  // initialize() always calls the current handler — without it,
  // initialize captures the first onCredential and stale-closures any
  // updates (state-dependent routing logic in the caller wouldn't see
  // current state).
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!CLIENT_ID) {
      warn("[gsi] NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset — button cannot render");
      onScriptError?.("Sign-in is misconfigured. Please contact support.");
      setStatus("error");
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
        // are allowed. width is in px; we use the card width.
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "filled_blue",
          size: "large",
          shape: "pill",
          text: "continue_with",
          logo_alignment: "left",
          width: 320,
        });
      }

      if (showOneTap) {
        // Auto-prompt for returning users. GIS itself decides whether to
        // show it (it won't if the user dismissed recently or has opted
        // out). The callback lets us log why it didn't display — useful
        // during the rollout to know if One Tap is being suppressed.
        window.google.accounts.id.prompt((notification) => {
          if (notification.isNotDisplayed()) {
            mark("[gsi] One Tap not displayed", {
              reason: notification.getNotDisplayedReason(),
            });
          } else if (notification.isSkippedMoment()) {
            mark("[gsi] One Tap skipped", {
              reason: notification.getSkippedReason(),
            });
          }
        });
      }

      setStatus("ready");
    }

    tryInit();

    return () => {
      cancelled = true;
      // Dismiss any open One Tap prompt on unmount so it doesn't linger
      // after navigating away from the auth pages.
      window.google?.accounts?.id?.cancel();
    };
  }, [onScriptError, showOneTap]);

  return (
    <div>
      <div ref={buttonRef} style={{ minHeight: "2.75rem" }} />
      {status === "loading" && (
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}>
          Loading sign-in…
        </p>
      )}
    </div>
  );
}
