"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import {
  COVER_BRANDING_OPTIONS,
  type CoverBranding,
} from "@/lib/firestore/events";
import CoverImage from "./CoverImage";
import styles from "./CoverBrandingModal.module.css";

type Props = {
  /** The just-cropped cover image to preview the treatment on. */
  posterUrl: string;
  /** Currently saved choice. */
  value: CoverBranding;
  /** Called with the chosen treatment when the organiser confirms. */
  onSelect: (branding: CoverBranding) => void;
  onClose: () => void;
};

/**
 * Shown after an organiser uploads (or replaces) an event cover image. Lets
 * them pick how the NAISI emblem sits on the cover, with a live preview that
 * is the exact treatment the public event page renders.
 */
export default function CoverBrandingModal({
  posterUrl,
  value,
  onSelect,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<CoverBranding>(value);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <p className={styles.title}>NAISI logo on the cover</p>
        <p className={styles.hint}>
          Pick how the emblem sits on this event&apos;s cover image. The preview
          is exactly what the event page will show.
        </p>

        <div className={styles.preview}>
          <CoverImage url={posterUrl} alt="" branding={selected} />
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

        <div className={styles.actions}>
          <Button
            onClick={() => {
              onSelect(selected);
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
