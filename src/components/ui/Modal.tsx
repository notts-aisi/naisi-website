"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useHistoryDismiss } from "@/hooks/useHistoryDismiss";
import styles from "./Modal.module.css";

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/** Tab-order candidates. Disabled controls and tabindex="-1" are excluded. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Accessible label announced by screen readers. */
  ariaLabel: string;
  children: ReactNode;
  /** `sm` = confirmations and single-field prompts; `md` = forms. */
  width?: "sm" | "md";
};

/**
 * Centred dialog over a scrim. Portalled to `document.body` so its z-index
 * lives in the document root rather than whichever parent rendered it.
 *
 * Always mounted after the first client render (like Drawer) so both open and
 * close transition. Children therefore keep their state and effects across a
 * close — callers that need them torn down should conditionally render the
 * `<Modal>` itself rather than only flipping `open`.
 *
 * Unlike Drawer this holds a real focus trap: the page behind stays visible,
 * so tabbing out of the dialog would put focus on content the user can see but
 * cannot reach past the scrim.
 */
export default function Modal({ open, onClose, ariaLabel, children, width = "md" }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // SSR-safe "are we on the client" check. The portal needs `document.body`,
  // which only exists client-side. useSyncExternalStore is React's idiomatic
  // shape for this (vs. useState+useEffect, which trips set-state-in-effect).
  const isClient = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  useBodyScrollLock(open);

  // Back gesture to close. Unconditional, matching the focus trap: a modal
  // that traps Tab should also swallow Back rather than let it navigate the
  // page out from under a half-filled form. Escape and the scrim close
  // through dismiss so the history entry unwinds with them.
  const dismiss = useHistoryDismiss(open, onClose);

  // Esc to close, plus the Tab/Shift-Tab loop. Bound to the window rather than
  // the panel so a Tab pressed while focus has drifted outside still lands
  // back inside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const items = focusableIn(panel);
      if (items.length === 0) {
        // Nothing tabbable inside — hold focus on the panel itself rather
        // than letting Tab walk into the inert page behind the scrim.
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (!(active instanceof HTMLElement) || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismiss]);

  // Focus the first interactive child on open (the panel itself if the dialog
  // is pure content); restore the previously focused element on close.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const panel = panelRef.current;
      if (panel) (focusableIn(panel)[0] ?? panel).focus();
    } else if (previouslyFocused.current) {
      previouslyFocused.current.focus();
      previouslyFocused.current = null;
    }
  }, [open]);

  if (!isClient) return null;

  return createPortal(
    <div className={styles.root} aria-hidden={!open} inert={!open}>
      <div className={`${styles.scrim} ${open ? styles.scrimOpen : ""}`} onClick={dismiss} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`${styles.panel} ${styles[`width_${width}`]} ${open ? styles.panelOpen : ""}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Tabbable descendants in DOM order. `getClientRects()` is the cheap
 * visibility filter that also covers `display: none` ancestors — it beats
 * `offsetParent`, which reports null for `position: fixed` children too.
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}
