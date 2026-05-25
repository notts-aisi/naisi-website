"use client";

import { useEffect } from "react";

/**
 * Locks page scrolling for the duration the (auth) flow is mounted.
 * Mobile-first concern: the loader's canvas + the soft-edge mask use
 * a fairly wide off-card bleed, which on phones can otherwise be
 * scrolled / rubber-banded into view. Combined with the viewport meta
 * (maximum-scale=1, user-scalable=no) exported from the (auth) layout
 * this keeps the login surface a stable, finger-friendly canvas.
 *
 * Restores prior styles on unmount so navigation away from the auth
 * area (e.g. to /dashboard) doesn't leak the locked state.
 */
export default function AuthBodyLock() {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      bodyTouch: body.style.touchAction,
    };
    html.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    body.style.touchAction = "manipulation";
    return () => {
      html.style.overflow = prev.htmlOverflow;
      html.style.overscrollBehavior = prev.htmlOverscroll;
      body.style.overflow = prev.bodyOverflow;
      body.style.overscrollBehavior = prev.bodyOverscroll;
      body.style.touchAction = prev.bodyTouch;
    };
  }, []);
  return null;
}
