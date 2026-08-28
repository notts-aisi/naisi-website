"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useHistoryDismiss } from "@/hooks/useHistoryDismiss";
import styles from "./Drawer.module.css";

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

type Props = {
  open: boolean;
  onClose: () => void;
  /** Element id, used for aria-controls on the trigger button. */
  id?: string;
  /** Accessible label announced by screen readers. */
  ariaLabel: string;
  children: ReactNode;
  /**
   * Drawer auto-closes when the viewport crosses this rem value upward
   * (e.g. iPad rotates landscape, desktop devtools resize). Defaults to 48
   * to match PublicHeader's --bp-md. AppShell passes 60 to match --bp-lg.
   */
  closeAboveRem?: number;
};

/**
 * Slide-from-left dialog. Used by PublicHeader on phones and (later) by
 * AppShell to host the role-conditional authed nav.
 *
 * Renders into a body-level portal so its z-index lives in the document
 * root, not whichever parent rendered it. Always mounted (after first
 * client render) so both open and close can transition.
 */
export default function Drawer({
  open,
  onClose,
  id,
  ariaLabel,
  children,
  closeAboveRem = 48,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // SSR-safe "are we on the client" check. The portal needs `document.body`,
  // which only exists client-side. useSyncExternalStore is React's idiomatic
  // shape for this (vs. useState+useEffect, which trips set-state-in-effect).
  const isClient = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  useBodyScrollLock(open);

  // Back gesture to close. Unconditional: a drawer is screen-occupying at
  // every width it appears at, and in an installed app the back gesture is
  // the primary way people expect to dismiss it.
  useHistoryDismiss(open, onClose);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus the first interactive child on open; restore the previously
  // focused element on close (the hamburger button, typically). Deliberately
  // no Tab trap: the drawer IS the page on the viewports it appears at, and
  // tabbing off the end into the browser chrome is the expected escape. Modal
  // traps because it overlays a page that stays visible behind it.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const first = panelRef.current?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    } else if (previouslyFocused.current) {
      previouslyFocused.current.focus();
      previouslyFocused.current = null;
    }
  }, [open]);

  // Auto-close when the viewport crosses `closeAboveRem` upward
  // (iPad rotate, window resize on desktop with devtools open, etc.).
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia(`(min-width: ${closeAboveRem}rem)`);
    const onChange = () => {
      if (mq.matches) onClose();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open, onClose, closeAboveRem]);

  if (!isClient) return null;

  return createPortal(
    <div className={styles.root} aria-hidden={!open} inert={!open}>
      <div
        className={`${styles.scrim} ${open ? styles.scrimOpen : ""}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`${styles.panel} ${open ? styles.panelOpen : ""}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
