"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Makes the system back gesture close an overlay instead of navigating away.
 *
 * Why this exists: in a browser tab the URL bar and the tab strip give you an
 * obvious way out of a page, so an overlay that only closes on Escape is
 * merely inconvenient on a phone. In an installed home-screen app there is no
 * browser chrome at all, and the Android back gesture (and the iOS left-edge
 * swipe) becomes the primary "close this" gesture. Without a history entry to
 * pop, that gesture navigates the page away, which on TaskDetailModal,
 * EventEditor and the newsletter block editor means losing unsaved work.
 *
 * The mechanism: while the overlay is open we push one history entry carrying
 * a marker. Back pops it, we see our marker is gone, and we close.
 *
 * DIRECTION OF CONTROL, learned the hard way: user-initiated dismissals
 * (Escape, the scrim, a sheet's close button) must go THROUGH history via the
 * returned `dismiss`, which calls history.back() and lets the popstate close
 * the overlay. The hook must NEVER call history.back() itself when `active`
 * flips false, because it cannot tell a user dismissal from a close caused by
 * NAVIGATION: the drawer's nav links close the drawer and push a route in the
 * same tap, Next's pushState has not landed when the effect runs, and an
 * unwind fired there pops the in-flight navigation. Shipped briefly, the
 * symptom was "drawer closes but the page never changes".
 *
 * Consequences of that rule, both deliberate:
 *   - A close that bypasses `dismiss` (a parent flipping `open` during
 *     navigation, an option-select a consumer has not routed through
 *     `dismiss`) leaves the marker entry in history. It is inert (no listener
 *     once inactive) and costs one silent Back press later. Strictly better
 *     than eating a navigation.
 *   - `dismiss` falls back to a plain onClose when the marker is not the top
 *     of the stack (a lower overlay closed while a higher one is open) or was
 *     never pushed (desktop popover mode). Consumers can therefore call it
 *     unconditionally as their only close path.
 *
 * Also load-bearing:
 *   - NESTING: the marker is a stack of ids; each instance acts only when its
 *     own id has left the stack, so Back closes the topmost overlay only.
 *   - NEXT'S ROUTER STATE: window.history.state carries the App Router tree,
 *     so the previous state is spread through, never replaced.
 *   - STRICT MODE: the pushed id lives in a ref and is created once per open,
 *     so the development double-invoke does not stack two entries.
 *
 * @param active whether the overlay is open AND screen-occupying. Components
 *   that are only app-shaped at some widths pass a narrowed value: Dropdown
 *   and PersonSelector pass `open && isSheet`.
 * @param onClose the close handler.
 * @returns dismiss: THE function user-dismissal paths must call.
 */
export function useHistoryDismiss(active: boolean, onClose: () => void): () => void {
  const pushedId = useRef<number | null>(null);
  // Kept in a ref so a consumer passing an inline arrow does not detach and
  // re-attach the popstate listener on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!active) {
      // Forget the entry but leave history alone; see the docblock for why
      // unwinding here is unsafe. The stale entry, if any, has no listener
      // and pops silently.
      pushedId.current = null;
      return;
    }

    if (pushedId.current === null) {
      const id = nextId();
      pushedId.current = id;
      window.history.pushState(
        { ...(window.history.state ?? {}), [STACK_KEY]: [...currentStack(), id] },
        "",
      );
    }

    const onPopState = () => {
      const id = pushedId.current;
      if (id === null) return;
      // Still in the stack means something above us was popped, not us.
      if (currentStack().includes(id)) return;
      pushedId.current = null;
      onCloseRef.current();
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [active]);

  return useCallback(() => {
    const id = pushedId.current;
    const stack = typeof window === "undefined" ? [] : currentStack();
    if (id !== null && stack.length > 0 && stack[stack.length - 1] === id) {
      // Our entry is on top: pop it, and the popstate handler above closes
      // the overlay. One history action, one close, nothing stale.
      window.history.back();
    } else {
      // Not in history (desktop popover mode), or not on top: close directly.
      onCloseRef.current();
    }
  }, []);
}

const STACK_KEY = "__naisiOverlays";

/** Ids only need to be unique within one document, so a counter is enough. */
let counter = 0;
const nextId = () => ++counter;

function currentStack(): number[] {
  const stack = (window.history.state as Record<string, unknown> | null)?.[STACK_KEY];
  return Array.isArray(stack) ? (stack as number[]) : [];
}
