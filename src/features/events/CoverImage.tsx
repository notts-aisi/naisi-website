"use client";

import { useRef } from "react";
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
  const dragging = useRef(false);
  // Pixel gap between the cursor and the badge centre at grab time, so the
  // badge tracks the cursor smoothly instead of snapping its centre under it.
  const grabOffset = useRef({ x: 0, y: 0 });

  const draggable = !!onPositionChange && branding === "corner";

  function handlePointerDown(e: React.PointerEvent<HTMLImageElement>) {
    const frame = frameRef.current;
    if (!frame) return;
    // Suppress the browser's native image drag / long-press callout so our
    // pointer handlers own the gesture (Safari is the main offender).
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const centreX = rect.left + (logoX / 100) * rect.width;
    const centreY = rect.top + (logoY / 100) * rect.height;
    grabOffset.current = { x: centreX - e.clientX, y: centreY - e.clientY };
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLImageElement>) {
    if (!dragging.current || !onPositionChange) return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((e.clientX + grabOffset.current.x - rect.left) / rect.width) * 100;
    const y = ((e.clientY + grabOffset.current.y - rect.top) / rect.height) * 100;
    // Round to 1 decimal so the position is smooth at sub-percent precision
    // (integer rounding snapped in ~6px steps on a 600px-wide preview).
    onPositionChange(
      Math.min(100, Math.max(0, Math.round(x * 10) / 10)),
      Math.min(100, Math.max(0, Math.round(y * 10) / 10)),
    );
  }

  function handlePointerUp(e: React.PointerEvent<HTMLImageElement>) {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
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
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={frameRef} className={styles.frame} style={frameStyle}>
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
          onPointerDown={draggable ? handlePointerDown : undefined}
          onPointerMove={draggable ? handlePointerMove : undefined}
          onPointerUp={draggable ? handlePointerUp : undefined}
          onPointerCancel={draggable ? handlePointerUp : undefined}
        />
      )}
    </div>
  );
}
