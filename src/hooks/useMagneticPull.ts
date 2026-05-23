"use client";

import { useEffect, useRef, type RefObject } from "react";

type Options = {
  /** Cursor distance from element centre at which pull starts (px). */
  radius?: number;
  /** Fraction of distance to translate by (0..1). */
  strength?: number;
  /** Max translate in px regardless of strength. */
  cap?: number;
};

/*
  Gently bends an element toward the cursor when within `radius` px.
  Springs back on mouseleave or when cursor moves out of range.

  Disabled when the user prefers reduced motion or is on a coarse-pointer
  device (touch). Throttled via rAF — single transform write per frame.
*/
export function useMagneticPull<T extends HTMLElement>({
  radius = 120,
  strength = 0.18,
  cap = 8,
}: Options = {}): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (reduced || coarse) return;

    let frame = 0;
    let lastX = 0;
    let lastY = 0;
    let dirty = false;

    const apply = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = lastX - cx;
      const dy = lastY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= radius) {
        const tx = Math.max(-cap, Math.min(cap, dx * strength));
        const ty = Math.max(-cap, Math.min(cap, dy * strength));
        node.style.setProperty("--mag-x", `${tx}px`);
        node.style.setProperty("--mag-y", `${ty}px`);
        dirty = true;
      } else if (dirty) {
        node.style.setProperty("--mag-x", "0px");
        node.style.setProperty("--mag-y", "0px");
        dirty = false;
      }
    };

    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const onLeave = () => {
      node.style.setProperty("--mag-x", "0px");
      node.style.setProperty("--mag-y", "0px");
      dirty = false;
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    node.addEventListener("mouseleave", onLeave);

    return () => {
      window.removeEventListener("mousemove", onMove);
      node.removeEventListener("mouseleave", onLeave);
      if (frame) cancelAnimationFrame(frame);
      node.style.removeProperty("--mag-x");
      node.style.removeProperty("--mag-y");
    };
  }, [radius, strength, cap]);

  return ref;
}
