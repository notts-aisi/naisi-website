"use client";

const SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;

type Grecaptcha = {
  ready: (cb: () => void) => void;
  execute: (siteKey: string, opts: { action: string }) => Promise<string>;
};

let scriptPromise: Promise<void> | null = null;

function loadScript(siteKey: string): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      resolve();
      return;
    }
    if (document.querySelector("script[data-recaptcha]")) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    s.async = true;
    s.defer = true;
    s.dataset.recaptcha = "true";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("reCAPTCHA failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * A reCAPTCHA v3 token for `action`, or null when reCAPTCHA isn't configured (no
 * NEXT_PUBLIC_RECAPTCHA_SITE_KEY). The server treats a missing token as a hard
 * fail only when ITS secret is set, so client + server stay in lockstep: both
 * unset = open (dev before keys), both set = enforced.
 */
export async function getRecaptchaToken(action: string): Promise<string | null> {
  if (!SITE_KEY) return null;
  const siteKey = SITE_KEY;
  try {
    await loadScript(siteKey);
    const g = (window as unknown as { grecaptcha?: Grecaptcha }).grecaptcha;
    if (!g) return null;
    return await new Promise<string | null>((resolve) => {
      g.ready(() => {
        g.execute(siteKey, { action })
          .then(resolve)
          .catch(() => resolve(null));
      });
    });
  } catch {
    return null;
  }
}
