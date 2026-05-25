"use client";

import { useEffect, useRef, useState } from "react";
import {
  COVER_LOGO_SCALE_DEFAULT,
  COVER_LOGO_X_DEFAULT,
  COVER_LOGO_Y_DEFAULT,
  COVER_STRIP_SIZE_DEFAULT,
  type CoverBranding,
  type CoverLogoColor,
  type CoverLogoPosition,
} from "@/lib/firestore/events";
import styles from "./CoverImage.module.css";

const EMBLEM_SRC: Record<CoverLogoColor, string> = {
  white: "/brand/naisi-emblem-white.png",
  colour: "/brand/naisi-emblem.png",
};

type Props = {
  url: string;
  alt: string;
  branding: CoverBranding;
  /** Emblem asset to overlay. Defaults to the white emblem. */
  logoColor?: CoverLogoColor;
  /** Gradient-strip height as a percent of the cover. Strip treatment only. */
  stripSize?: number;
  /** Which edge the gradient strip sits against. Strip treatment only. */
  logoPosition?: CoverLogoPosition;
  /** Logo size as a percent of its default footprint. */
  logoScale?: number;
  /** Corner-badge centre X, as a percent of the cover width. */
  logoX?: number;
  /** Corner-badge centre Y, as a percent of the cover height. */
  logoY?: number;
  /** Corner badge: whether the emblem sits on a frosted backing box. */
  logoBackdrop?: boolean;
  /** Corner badge: whether the logo (or its box) carries a drop shadow. */
  logoShadow?: boolean;
  /**
   * When provided, the corner badge becomes draggable: dragging it reports a
   * new centre (x, y) as a percent of the cover. Used by the branding editor;
   * omitted on the public page, where the cover is static.
   */
  onPositionChange?: (x: number, y: number) => void;
};

/**
 * An event cover image with the optional NAISI emblem treatment overlaid.
 * Shared by the public/preview event page (EventDetailView) and the editor's
 * cover-branding picker, so the picker preview is exactly what ships.
 */
export default function CoverImage({
  url,
  alt,
  branding,
  logoColor = "white",
  stripSize = COVER_STRIP_SIZE_DEFAULT,
  logoPosition = "bottom",
  logoScale = COVER_LOGO_SCALE_DEFAULT,
  logoX = COVER_LOGO_X_DEFAULT,
  logoY = COVER_LOGO_Y_DEFAULT,
  logoBackdrop = true,
  logoShadow = true,
  onPositionChange,
}: Props) {
  const emblemSrc = EMBLEM_SRC[logoColor];
  const atTop = logoPosition === "top";
  const frameRef = useRef<HTMLDivElement>(null);
  // Click-to-pick-up / click-to-place: first click on the emblem lifts it,
  // the cursor then drives the position live, and the next click anywhere
  // commits. Escape reverts to the position at the moment of pick-up.
  const [placing, setPlacing] = useState(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);

  const draggable = !!onPositionChange && branding === "corner";

  useEffect(() => {
    if (!placing || !onPositionChange) return;
    const frame = frameRef.current;
    if (!frame) return;

    function applyAt(e: PointerEvent) {
      const rect = frame!.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      // 1-decimal rounding so the position is smooth at sub-percent precision
      // (integer rounding snapped in ~6px steps on a 600px-wide preview).
      onPositionChange!(
        Math.min(100, Math.max(0, Math.round(x * 10) / 10)),
        Math.min(100, Math.max(0, Math.round(y * 10) / 10)),
      );
    }

    function onMove(e: PointerEvent) {
      // Desktop: cursor drives the emblem live. Touch: pointermove only
      // fires while a finger is in contact, but the pointerdown commit
      // below still places the emblem at the tap location.
      applyAt(e);
    }
    function onDown(e: PointerEvent) {
      // Commit when the click lands on the cover itself; clicks outside
      // (modal controls, close button, sliders) just cancel placing
      // without nudging the saved position.
      const target = e.target as Node | null;
      if (target && frame!.contains(target)) {
        applyAt(e);
      }
      setPlacing(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (startPos.current) {
          onPositionChange!(startPos.current.x, startPos.current.y);
        }
        setPlacing(false);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [placing, onPositionChange]);

  function handleEmblemPointerDown(e: React.PointerEvent<HTMLImageElement>) {
    if (!draggable) return;
    // Suppress native image drag / long-press callout and stop the event
    // from bubbling to the window pointerdown handler above (which would
    // otherwise treat this same press as the "commit" tap).
    e.preventDefault();
    e.stopPropagation();
    if (placing) {
      setPlacing(false);
      return;
    }
    // Disambiguate click vs drag from this single pointerdown: if the
    // pointer moves past a small threshold before release, treat it as a
    // hold-drag and the release position is the final placement; otherwise
    // it was a click and we enter placing mode for click-to-place.
    const frame = frameRef.current;
    if (!frame || !onPositionChange) return;
    const downX = e.clientX;
    const downY = e.clientY;
    const rect = frame.getBoundingClientRect();
    const centreX = rect.left + (logoX / 100) * rect.width;
    const centreY = rect.top + (logoY / 100) * rect.height;
    const grabOffsetX = centreX - e.clientX;
    const grabOffsetY = centreY - e.clientY;
    let mode: "pending" | "dragging" = "pending";
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (mode === "pending") {
        const dx = Math.abs(ev.clientX - downX);
        const dy = Math.abs(ev.clientY - downY);
        if (dx > 4 || dy > 4) mode = "dragging";
      }
      if (mode === "dragging") {
        const r = frame.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const x = ((ev.clientX + grabOffsetX - r.left) / r.width) * 100;
        const y = ((ev.clientY + grabOffsetY - r.top) / r.height) * 100;
        onPositionChange(
          Math.min(100, Math.max(0, Math.round(x * 10) / 10)),
          Math.min(100, Math.max(0, Math.round(y * 10) / 10)),
        );
      }
    };

    const onUp = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      if (target.hasPointerCapture(ev.pointerId)) {
        target.releasePointerCapture(ev.pointerId);
      }
      if (mode === "pending") {
        // It was a click — enter placing mode.
        startPos.current = { x: logoX, y: logoY };
        setPlacing(true);
      }
      // If dragging, the position was already committed by the last onMove.
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  const frameStyle = {
    "--logo-scale": logoScale / 100,
    "--logo-x": `${logoX}%`,
    "--logo-y": `${logoY}%`,
  } as React.CSSProperties;

  const cornerClass = [
    styles.cornerEmblem,
    logoBackdrop ? styles.cornerEmblemBoxed : "",
    logoBackdrop && logoColor === "colour" ? styles.cornerEmblemLight : "",
    logoShadow
      ? logoBackdrop
        ? styles.cornerEmblemShadowBox
        : styles.cornerEmblemShadowBare
      : "",
    draggable ? styles.cornerEmblemDraggable : "",
    placing ? styles.cornerEmblemPlacing : "",
  ]
    .filter(Boolean)
    .join(" ");

  const frameClass = [styles.frame, placing ? styles.framePlacing : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={frameRef} className={frameClass} style={frameStyle}>
      {/* User-uploaded Firebase Storage image - next/image optimization isn't
          worth the remote-pattern config here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className={styles.poster} />

      {branding === "strip" && (
        <div
          className={`${styles.strip}${atTop ? ` ${styles.stripTop}` : ""}`}
          style={{ height: `${stripSize}%` }}
          aria-hidden="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={emblemSrc} alt="" className={styles.stripEmblem} />
        </div>
      )}

      {branding === "corner" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={emblemSrc}
          alt=""
          aria-hidden="true"
          // Disable the browser's native HTML5 image-drag (ghost preview) so it
          // doesn't race our pointer handlers when the editor takes over the
          // gesture. Harmless on the public page (where there's no drag at all).
          draggable={false}
          className={cornerClass}
          onPointerDown={draggable ? handleEmblemPointerDown : undefined}
        />
      )}
    </div>
  );
}
