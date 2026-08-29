"use client";

import { useEffect, useRef } from "react";

/**
 * Makes the system back gesture close an overlay instead of navigating away.
 *
 * Why this exists: in a browser tab the URL bar and the tab strip give you an
 * obvious way out of a page, so an overlay that only closes on Escape is
 * merely inconvenient on a phone. In an installed home-screen app there is no
 * browser chrome at all, and the Android back gesture (and the iOS left-edge
 * swipe) becomes the primary "close this" gesture. Without a history entry to
 * pop, that gesture navigates the page away instead, which on TaskDetailModal,
 * EventEditor and the newsletter block editor means losing unsaved work.
 *
 * The mechanism: while the overlay is open we push one history entry carrying
 * a marker. Back pops it, we see our marker is gone, and we close. A close
 * that happens any other way (Escape, the scrim, picking an option) unwinds
 * that entry so the user's next Back still goes where they expect.
 *
 * Four things this has to get right, all of which are easy to miss:
 *
 * 1. NESTING. A Dropdown inside a Modal inside a Drawer is reachable here, so
 *    the marker is a STACK of ids rather than a single value. Back closes only
 *    the topmost: each instance acts only when its own id has left the stack.
 *
 * 2. NEXT'S ROUTER STATE. window.history.state carries the App Router's tree.
 *    Pushing a bare object would strip it and break client navigation from an
 *    open overlay, so the previous state is always spread through.
 *
 * 3. REACT STRICT MODE. Effects double-invoke in development. Pushing on every
 *    invocation would stack two entries per open and need two Backs to close.
 *    The pushed id lives in a ref and is only created once per open, so the
 *    second invocation re-attaches the listener without pushing again.
 *
 * 4. NOT UNWINDING IN CLEANUP. The unwind runs in the effect body of the
 *    inactive pass, not in the cleanup of the active one. Cleanup cannot tell
 *    a genuine close from Strict Mode's simulated remount, and calling
 *    history.back() during a remount pops an entry that is about to be pushed
 *    again, which closes the overlay the instant it opens.
 *
 * KNOWN WART, in two shapes, both costing one extra Back press and neither
 * worth the complexity of fixing:
 *
 *   - Navigating while an overlay is open (tapping a link in the nav drawer)
 *     strands our entry behind the new route. Next's pushState replaces the
 *     state object, so our marker is no longer current and we correctly
 *     decline to unwind it. Fixing it properly would mean every consumer
 *     closing its overlay before navigating.
 *   - Unmounting while open. Modal's docblock invites callers to
 *     conditionally render it rather than flip `open`, so this is reachable.
 *     Unwinding from an unmount cleanup is not safe, because Strict Mode's
 *     simulated remount is indistinguishable from a real unmount and the
 *     resulting back() would pop the entry the remount just pushed, closing
 *     the overlay the instant it opens. Prefer toggling `active` over
 *     unmounting where you have the choice.
 *
 * Both are strictly better than the alternative, which is Back discarding
 * whatever the overlay was holding.
 *
 * @param active whether the overlay is open AND is screen-occupying. Pass a
 *   narrowed value for components that are only app-shaped at some widths:
 *   Dropdown and PersonSelector should pass `open && isSheet`, because a
 *   desktop popover is not something Back should close.
 * @param onClose the same close handler Escape and the scrim call.
 */
export function useHistoryDismiss(active: boolean, onClose: () => void) {
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
      // Closed some way other than Back (Escape, scrim, picking an option).
      // Drop our entry so the user's next Back goes somewhere real rather
      // than silently unwinding a stale overlay entry.
      const id = pushedId.current;
      pushedId.current = null;
      if (id !== null && currentStack().includes(id)) {
        window.history.back();
      }
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
      // Our entry is already gone, so there is nothing left to unwind.
      pushedId.current = null;
      onCloseRef.current();
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [active]);
}

const STACK_KEY = "__naisiOverlays";

/** Ids only need to be unique within one document, so a counter is enough. */
let counter = 0;
const nextId = () => ++counter;

function currentStack(): number[] {
  const stack = (window.history.state as Record<string, unknown> | null)?.[STACK_KEY];
  return Array.isArray(stack) ? (stack as number[]) : [];
}
