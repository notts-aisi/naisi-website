"use client";

import { useRef, useState } from "react";
import ReactCrop, {
  centerCrop,
  convertToPixelCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import Button from "@/components/ui/Button";
import styles from "./ImageCropModal.module.css";

type ModeId = "wide" | "standard" | "tall" | "free";

const MODES: { id: ModeId; label: string; aspect?: number }[] = [
  { id: "wide", label: "Wide 3:1", aspect: 3 },
  { id: "standard", label: "Standard 2:1", aspect: 2 },
  { id: "tall", label: "Tall 16:9", aspect: 16 / 9 },
  { id: "free", label: "Free" },
];

type Props = {
  /** Object URL of the picked image. */
  src: string;
  /** Original file name, reused for the cropped output. */
  fileName: string;
  /** Cropped image, ready to upload. */
  onCropped: (file: File) => void;
  /** Upload the image untouched. */
  onSkip: () => void;
  /** Dismiss without uploading anything. */
  onCancel: () => void;
};

function centeredAspectCrop(width: number, height: number, aspect: number): Crop {
  return centerCrop(
    makeAspectCrop({ unit: "%", width: 90 }, aspect, width, height),
    width,
    height,
  );
}

async function cropToFile(
  image: HTMLImageElement,
  crop: PixelCrop,
  fileName: string,
): Promise<File> {
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * scaleX));
  canvas.height = Math.max(1, Math.round(crop.height * scaleY));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available in this browser.");
  ctx.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    crop.width * scaleX,
    crop.height * scaleY,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Could not crop the image.");
  const base = fileName.replace(/\.[^.]+$/, "") || "cover";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
}

/**
 * Lets an organiser frame a cover image before upload: ratio presets (3:1, 2:1,
 * 16:9), a free-form rectangle, or skip cropping entirely. The event page shows
 * the result at its true shape, so a portrait photo can never crop badly.
 */
export default function ImageCropModal({
  src,
  fileName,
  onCropped,
  onSkip,
  onCancel,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [mode, setMode] = useState<ModeId>("standard");
  const [crop, setCrop] = useState<Crop>();
  const [completed, setCompleted] = useState<PixelCrop>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aspect = MODES.find((m) => m.id === mode)?.aspect;

  function frameCrop(img: HTMLImageElement, asp: number | undefined) {
    const next: Crop = asp
      ? centeredAspectCrop(img.width, img.height, asp)
      : { unit: "%", x: 5, y: 5, width: 90, height: 90 };
    setCrop(next);
    setCompleted(convertToPixelCrop(next, img.width, img.height));
  }

  function applyMode(next: ModeId) {
    setMode(next);
    const img = imgRef.current;
    if (img) frameCrop(img, MODES.find((m) => m.id === next)?.aspect);
  }

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    frameCrop(e.currentTarget, aspect ?? 2);
  }

  async function useCrop() {
    if (!completed?.width || !completed.height || !imgRef.current) return;
    setBusy(true);
    setError(null);
    try {
      onCropped(await cropToFile(imgRef.current, completed, fileName));
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not crop the image.");
    }
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <p className={styles.title}>Crop the cover image</p>
        <p className={styles.hint}>
          Pick a shape, then drag to frame the photo. The event page shows
          exactly what you crop here. &quot;Free&quot; lets you draw any
          rectangle; &quot;Use original&quot; uploads it untouched.
        </p>

        <div className={styles.modes}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={m.id === mode ? styles.modeActive : styles.mode}
              onClick={() => applyMode(m.id)}
              disabled={busy}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className={styles.cropArea}>
          <ReactCrop
            crop={crop}
            onChange={(_pixelCrop, percentCrop) => setCrop(percentCrop)}
            onComplete={(pixelCrop) => setCompleted(pixelCrop)}
            aspect={aspect}
            keepSelection
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={src}
              alt=""
              onLoad={onImageLoad}
              className={styles.cropImg}
            />
          </ReactCrop>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <Button onClick={useCrop} disabled={busy || !completed?.width}>
            {busy ? "Cropping…" : "Use this crop"}
          </Button>
          <Button variant="ghost" onClick={onSkip} disabled={busy}>
            Use original
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
