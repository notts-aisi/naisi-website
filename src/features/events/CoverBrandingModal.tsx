"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
import {
  COVER_BRANDING_OPTIONS,
  COVER_LOGO_SCALE_MAX,
  COVER_LOGO_SCALE_MIN,
  COVER_STRIP_SIZE_MAX,
  COVER_STRIP_SIZE_MIN,
  type CoverBranding,
  type CoverLogoColor,
  type CoverLogoPosition,
} from "@/lib/firestore/events";
import CoverImage from "./CoverImage";
import styles from "./CoverBrandingModal.module.css";

export type CoverBrandingChoice = {
  branding: CoverBranding;
  logoColor: CoverLogoColor;
  stripSize: number;
  logoPosition: CoverLogoPosition;
  logoScale: number;
  logoX: number;
  logoY: number;
  logoBackdrop: boolean;
  logoShadow: boolean;
};

type Props = {
  /** The just-cropped cover image to preview the treatment on. */
  posterUrl: string;
  /** Currently saved branding choice. */
  value: CoverBranding;
  logoColor: CoverLogoColor;
  stripSize: number;
  logoPosition: CoverLogoPosition;
  logoScale: number;
  logoX: number;
  logoY: number;
  logoBackdrop: boolean;
  logoShadow: boolean;
  /** Called with the chosen treatment when the organiser confirms. */
  onSelect: (choice: CoverBrandingChoice) => void;
  onClose: () => void;
};

const LOGO_COLOR_OPTIONS = [
  { value: "white" as const, label: "White" },
  { value: "colour" as const, label: "Full colour" },
];

const LOGO_POSITION_OPTIONS = [
  { value: "bottom" as const, label: "Bottom" },
  { value: "top" as const, label: "Top" },
];

/**
 * Shown after an organiser uploads (or replaces) an event cover image. Lets
 * them pick how the NAISI emblem sits on the cover, with a live preview that
 * is the exact treatment the public event page renders. The corner badge is
 * dragged directly on the preview to position it.
 */
export default function CoverBrandingModal({
  posterUrl,
  value,
  logoColor,
  stripSize,
  logoPosition,
  logoScale,
  logoX,
  logoY,
  logoBackdrop,
  logoShadow,
  onSelect,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<CoverBranding>(value);
  const [selectedColor, setSelectedColor] = useState<CoverLogoColor>(logoColor);
  const [selectedStrip, setSelectedStrip] = useState(stripSize);
  const [selectedPosition, setSelectedPosition] =
    useState<CoverLogoPosition>(logoPosition);
  const [selectedScale, setSelectedScale] = useState(logoScale);
  const [selectedX, setSelectedX] = useState(logoX);
  const [selectedY, setSelectedY] = useState(logoY);
  const [selectedBackdrop, setSelectedBackdrop] = useState(logoBackdrop);
  const [selectedShadow, setSelectedShadow] = useState(logoShadow);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <p className={styles.title}>NAISI logo on the cover</p>
        <p className={styles.hint}>
          Pick how the emblem sits on this event&apos;s cover image. The preview
          is exactly what the event page will show.
        </p>

        <div className={styles.preview}>
          <CoverImage
            url={posterUrl}
            alt=""
            branding={selected}
            logoColor={selectedColor}
            stripSize={selectedStrip}
            logoPosition={selectedPosition}
            logoScale={selectedScale}
            logoX={selectedX}
            logoY={selectedY}
            logoBackdrop={selectedBackdrop}
            logoShadow={selectedShadow}
            onPositionChange={
              selected === "corner"
                ? (x, y) => {
                    setSelectedX(x);
                    setSelectedY(y);
                  }
                : undefined
            }
          />
        </div>

        <div className={styles.options}>
          {COVER_BRANDING_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={opt.id === selected ? styles.optionActive : styles.option}
              onClick={() => setSelected(opt.id)}
              aria-pressed={opt.id === selected}
            >
              <span className={styles.optionLabel}>{opt.label}</span>
              <span className={styles.optionDesc}>{opt.description}</span>
            </button>
          ))}
        </div>

        {selected !== "none" && (
          <div className={styles.control}>
            <span className={styles.controlLabel}>Logo colour</span>
            <SegmentedControl
              value={selectedColor}
              onChange={setSelectedColor}
              options={LOGO_COLOR_OPTIONS}
              ariaLabel="Logo colour"
              size="sm"
            />
          </div>
        )}

        {selected !== "none" && (
          <div className={styles.control}>
            <label className={styles.controlLabel} htmlFor="cover-logo-size">
              Logo size
            </label>
            <div className={styles.sliderRow}>
              <input
                id="cover-logo-size"
                type="range"
                className={styles.slider}
                min={COVER_LOGO_SCALE_MIN}
                max={COVER_LOGO_SCALE_MAX}
                value={selectedScale}
                onChange={(e) => setSelectedScale(Number(e.target.value))}
              />
              <span className={styles.sliderValue}>{selectedScale}%</span>
            </div>
          </div>
        )}

        {selected === "strip" && (
          <div className={styles.control}>
            <span className={styles.controlLabel}>Strip position</span>
            <SegmentedControl
              value={selectedPosition}
              onChange={setSelectedPosition}
              options={LOGO_POSITION_OPTIONS}
              ariaLabel="Strip position"
              size="sm"
            />
          </div>
        )}

        {selected === "strip" && (
          <div className={styles.control}>
            <label className={styles.controlLabel} htmlFor="cover-strip-size">
              Gradient strip size
            </label>
            <div className={styles.sliderRow}>
              <input
                id="cover-strip-size"
                type="range"
                className={styles.slider}
                min={COVER_STRIP_SIZE_MIN}
                max={COVER_STRIP_SIZE_MAX}
                value={selectedStrip}
                onChange={(e) => setSelectedStrip(Number(e.target.value))}
              />
              <span className={styles.sliderValue}>{selectedStrip}%</span>
            </div>
          </div>
        )}

        {selected === "corner" && (
          <div className={styles.control}>
            <p className={styles.hint}>
              Drag the logo on the preview above to place it anywhere on the
              cover.
            </p>
            <Switch
              checked={selectedBackdrop}
              onChange={setSelectedBackdrop}
              label="Background box"
              description="A frosted panel behind the logo so it reads on any photo."
            />
            <Switch
              checked={selectedShadow}
              onChange={setSelectedShadow}
              label="Drop shadow"
              description="A soft shadow so the logo lifts off the image."
            />
          </div>
        )}

        <div className={styles.actions}>
          <Button
            onClick={() => {
              onSelect({
                branding: selected,
                logoColor: selectedColor,
                stripSize: selectedStrip,
                logoPosition: selectedPosition,
                logoScale: selectedScale,
                logoX: selectedX,
                logoY: selectedY,
                logoBackdrop: selectedBackdrop,
                logoShadow: selectedShadow,
              });
              onClose();
            }}
          >
            Use this
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
