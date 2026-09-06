"use client";

import { useEffect } from "react";

/**
 * Pins the page behind an overlay for as long as `active` is true.
 *
 * `overflow: hidden` on <html> alone does not stop touch-scroll on iOS, hence
 * the `position: fixed; top: -scrollY` pin and the explicit scroll restore on
 * release. Extracted from Drawer so Drawer and Modal pin identically.
 *
 * ONE lock at a time. While the body is pinned `window.scrollY` reads 0, so a
 * second overlay locking on top of a first would capture 0 as the restore
 * offset and drop the page to the top on release. Overlays that can stack
 * (a Modal opened from inside a Drawer) must close the outer one first.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    const body = document.body;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
