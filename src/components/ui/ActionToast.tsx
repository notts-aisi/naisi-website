"use client";

import { useCallback, useEffect, useState } from "react";

type Phase = "saving" | "success" | "error";
export type ToastState = { phase: Phase; message: string; pct: number } | null;

// The bar is a deliberate visual aid: the underlying call often lands in
// <100ms, so we hold the "saving" state for a minimum window and only complete
// the bar a beat after the call has actually landed — otherwise it just flickers.
const MIN_VISIBLE_MS = 900;
const SUCCESS_HOLD_MS = 1100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drives an <ActionToast> through saving → success / error with the minimum
 * visible window above. Returns `run(action, opts)` — wrap any async mutation
 * with it and the toast handles the feedback (and surfaces thrown errors).
 */
export function useActionToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const dismiss = useCallback(() => setToast(null), []);

  const run = useCallback(
    async (
      action: () => Promise<void>,
      opts: { savingMessage?: string; successMessage?: string } = {},
    ) => {
      setToast({ phase: "saving", message: opts.savingMessage ?? "Saving…", pct: 6 });
      // Next frame: ease the bar toward ~92% (the CSS transition fills it
      // smoothly across the minimum window; the last 8% snaps on success).
      requestAnimationFrame(() =>
        setToast((t) => (t && t.phase === "saving" ? { ...t, pct: 92 } : t)),
      );
      const start = performance.now();
      try {
        await action();
        const remaining = MIN_VISIBLE_MS - (performance.now() - start);
        if (remaining > 0) await sleep(remaining);
        setToast({ phase: "success", message: opts.successMessage ?? "Saved", pct: 100 });
        await sleep(SUCCESS_HOLD_MS);
        setToast((t) => (t?.phase === "success" ? null : t));
      } catch (err) {
        setToast({
          phase: "error",
          message: err instanceof Error ? err.message : "Something went wrong.",
          pct: 100,
        });
      }
    },
    [],
  );

  return { toast, run, dismiss };
}

/** Centre-screen modal with a dimmed backdrop and a progress bar. Render once
 *  per surface and feed it the state from useActionToast(); returns null when
 *  idle. The backdrop dims the page so the feedback is unmissable. */
export default function ActionToast({
  toast,
  onDismiss,
}: {
  toast: ToastState;
  onDismiss: () => void;
}) {
  // Escape closes a (persistent) error. Effect runs unconditionally so the
  // hook order stays stable; the early return below is after it.
  useEffect(() => {
    if (!toast || toast.phase !== "error") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const color =
    toast.phase === "error"
      ? "var(--color-danger)"
      : toast.phase === "success"
        ? "var(--color-success)"
        : "var(--color-accent)";
  const icon = toast.phase === "error" ? "✕" : toast.phase === "success" ? "✓" : null;

  return (
    <div
      // Backdrop. Click to dismiss only while showing a (persistent) error —
      // saving / success are transient and shouldn't be interrupted.
      onClick={toast.phase === "error" ? onDismiss : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
      }}
    >
      <div
        role="status"
        aria-live="polite"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(92vw, 24rem)",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.55)",
          padding: "var(--space-5)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {icon && (
            <span aria-hidden="true" style={{ color, fontWeight: 700, fontSize: "var(--text-lg)" }}>
              {icon}
            </span>
          )}
          <span
            style={{
              flex: 1,
              color: toast.phase === "error" ? "var(--color-danger)" : "var(--color-text)",
              fontSize: "var(--text-sm)",
              fontWeight: 500,
            }}
          >
            {toast.message}
          </span>
          {toast.phase === "error" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              style={{
                background: "none",
                border: "none",
                color: "var(--color-text-muted)",
                cursor: "pointer",
                fontSize: "var(--text-sm)",
                lineHeight: 1,
                padding: 0,
              }}
            >
              ✕
            </button>
          )}
        </div>
        <div
          style={{
            height: 4,
            background: "var(--color-surface-hover)",
            borderRadius: "var(--radius-pill)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${toast.pct}%`,
              height: "100%",
              background: color,
              transition:
                toast.phase === "saving"
                  ? "width 850ms cubic-bezier(0.33, 0, 0.2, 1)"
                  : "width 260ms ease-out, background 200ms ease",
            }}
          />
        </div>
      </div>
    </div>
  );
}
