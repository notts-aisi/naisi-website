"use client";

import { useSyncExternalStore } from "react";

/**
 * False in the server markup and through the hydrating render, true from the
 * moment React has taken the page over.
 *
 * What it is for: a server-rendered form is on screen and pressable long
 * before its JavaScript arrives, and a press in that window runs the browser's
 * own default submission: the document reloads with empty fields and nothing
 * said. Gating a submit button on this puts `disabled` in the server markup,
 * which is the honest description of a form nothing is listening to yet, and
 * drops it the moment the form is live. It is half of the fix; the other half
 * is that the boxes such a form reads must be uncontrolled, or React's first
 * render writes its own empty state over what was typed.
 *
 * `useSyncExternalStore` rather than a flag flipped in an effect, matching
 * useOnline and useIsStandalone: the server snapshot is what hydration
 * renders, so there is no mismatch to warn about, and a client-side navigation
 * (no server markup in play) reads true on its very first render instead of
 * flickering through a disabled frame.
 *
 * The store never changes, so the subscriber is never called: the one
 * transition is hydration itself, and React re-reads the snapshot then.
 */
const subscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
