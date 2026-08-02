"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;

/**
 * True when a reCAPTCHA site key is configured. Callers skip the check entirely
 * when this is false, so local dev without keys still works.
 */
export const RECAPTCHA_ENABLED = Boolean(SITE_KEY);

type RenderParams = {
  sitekey: string;
  size: "invisible";
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
};

type Grecaptcha = {
  render: (container: HTMLElement, params: RenderParams) => number;
  execute: (widgetId?: number) => void;
  reset: (widgetId?: number) => void;
};

declare global {
  interface Window {
    grecaptcha?: Grecaptcha;
  }
}

let scriptPromise: Promise<Grecaptcha | null> | null = null;

/**
 * Load the reCAPTCHA v2 API script once, in explicit-render mode, and resolve the
 * `grecaptcha` object when it's usable. Resolves null when there's no document
 * (SSR), the script fails to load, or the API never finishes initializing.
 *
 * NB: `grecaptcha.render` is populated ASYNCHRONOUSLY, a beat after the script's
 * `load` event fires — at onload `window.grecaptcha` already exists but `.render`
 * is still undefined. So we poll for `.render` to actually appear rather than
 * trusting onload (which lands too early and would make us give up).
 */
function loadGrecaptcha(): Promise<Grecaptcha | null> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<Grecaptcha | null>((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    let waited = 0;
    const poll = () => {
      const g = window.grecaptcha;
      if (g?.render) {
        resolve(g);
        return;
      }
      waited += 100;
      if (waited > 10000) {
        console.error("[recaptcha] timed out waiting for the API to initialize");
        resolve(null);
        return;
      }
      setTimeout(poll, 100);
    };
    if (!document.querySelector("script[data-recaptcha]")) {
      const s = document.createElement("script");
      s.src = "https://www.google.com/recaptcha/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      s.dataset.recaptcha = "true";
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    }
    poll();
  });
  return scriptPromise;
}

export type RecaptchaHandle = {
  /**
   * Run the invisible check and resolve a single-use token — silently for a
   * trusted user, or after Google pops a challenge for a flagged one. Resolves
   * null when reCAPTCHA isn't configured, the script failed to load, or the
   * challenge was dismissed/errored (callers fail closed on null).
   */
  execute: () => Promise<string | null>;
};

/**
 * Invisible reCAPTCHA v2 — renders no checkbox, only the floating badge. Mount it
 * once and drive it imperatively via the ref: `await ref.current?.execute()` on
 * submit. A flagged user gets an image-challenge popup before the token resolves;
 * everyone else passes silently. Renders nothing when no site key is configured.
 */
export const RecaptchaInvisible = forwardRef<RecaptchaHandle>(
  function RecaptchaInvisible(_props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const widgetIdRef = useRef<number | null>(null);
    const grecaptchaRef = useRef<Grecaptcha | null>(null);
    // Resolver for the in-flight execute(). The widget's callbacks fire here.
    const pendingRef = useRef<((token: string | null) => void) | null>(null);

    useEffect(() => {
      if (!SITE_KEY) return;
      let cancelled = false;
      void loadGrecaptcha().then((g) => {
        if (cancelled || !g || !containerRef.current || widgetIdRef.current !== null) {
          return;
        }
        const settle = (token: string | null) => {
          const resolve = pendingRef.current;
          pendingRef.current = null;
          resolve?.(token);
        };
        grecaptchaRef.current = g;
        try {
          widgetIdRef.current = g.render(containerRef.current, {
            sitekey: SITE_KEY,
            size: "invisible",
            callback: (token) => settle(token),
            "expired-callback": () => settle(null),
            "error-callback": () => settle(null),
          });
        } catch (err) {
          // Most commonly "Invalid key type" — a Checkbox key used as Invisible.
          console.error("[recaptcha] widget render failed", err);
        }
      });
      return () => {
        cancelled = true;
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        execute: () =>
          new Promise<string | null>((resolve) => {
            const g = grecaptchaRef.current;
            if (!SITE_KEY || !g || widgetIdRef.current === null) {
              resolve(null);
              return;
            }
            // Cancel any in-flight execute so its promise doesn't dangle.
            pendingRef.current?.(null);
            pendingRef.current = (token) => {
              g.reset(widgetIdRef.current ?? undefined);
              resolve(token);
            };
            try {
              g.execute(widgetIdRef.current);
            } catch {
              pendingRef.current = null;
              resolve(null);
            }
          }),
      }),
      [],
    );

    if (!SITE_KEY) return null;
    return <div ref={containerRef} />;
  },
);
