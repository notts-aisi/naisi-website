"use client";

import { useEffect, useRef, type RefObject } from "react";

type Options = {
  /** Max rotation in degrees per axis. */
  max?: number;
  /** Perspective in px (smaller = more dramatic). */
  perspective?: number;
};

/*
  Applies a perspective rotateX/rotateY to an element based on the cursor
  position within it. Springs back to flat on mouseleave.

  Disabled under prefers-reduced-motion and on coarse-pointer devices.
  Writes inline transform — element should set its own base transition
  in CSS to ease the springback.
*/
export function useTilt<T extends HTMLElement>({
  max = 7,
  perspective = 800,
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

    const apply = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const nx = (lastX - rect.left) / rect.width - 0.5;
      const ny = (lastY - rect.top) / rect.height - 0.5;
      const rx = -ny * max * 2;
      const ry = nx * max * 2;
      node.style.transform = `perspective(${perspective}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    };

    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const onLeave = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      node.style.transform = `perspective(${perspective}px) rotateX(0deg) rotateY(0deg)`;
    };

    node.addEventListener("mousemove", onMove);
    node.addEventListener("mouseleave", onLeave);

    return () => {
      node.removeEventListener("mousemove", onMove);
      node.removeEventListener("mouseleave", onLeave);
      if (frame) cancelAnimationFrame(frame);
      node.style.transform = "";
    };
  }, [max, perspective]);

  return ref;
}
