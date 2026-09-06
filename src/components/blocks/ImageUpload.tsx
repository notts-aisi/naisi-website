"use client";

import { useRef, useState } from "react";
import imageCompression from "browser-image-compression";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import Button from "@/components/ui/Button";
import { getClientStorage } from "@/lib/firebase/client";
import ImageCropModal from "./ImageCropModal";
import styles from "./ImageUpload.module.css";

type Props = {
  draftId: string;
  /** Storage folder prefix. Defaults to newsletter-images for backwards compat. */
  storagePrefix?: string;
  currentUrl?: string;
  currentAlt?: string;
  currentCaption?: string;
  onChange: (next: { url: string; alt: string; caption?: string; storagePath?: string }) => void;
  disabled?: boolean;
  /** When true, the organiser frames the image in a crop modal before upload. */
  enableCrop?: boolean;
  /**
   * Drop the alt-text and caption inputs, for a caller whose model has nowhere
   * to put either. A worksheet OPTION image is the case: it stores a URL and a
   * storage path only, and it is rendered beside the option's own label, which
   * is the accessible name a screen reader wants. Without this the author
   * types alt text into a box and the save silently discards it.
   *
   * Default false, so every caller that predates the prop keeps both fields.
   */
  hideTextFields?: boolean;
};

type UploadState =
  | { kind: "idle" }
  | { kind: "compressing" }
  | { kind: "uploading"; progress: number }
  | { kind: "error"; message: string };

const MAX_DIMENSION = 1600;
const MAX_SIZE_MB = 3;

/**
 * Storage prefixes whose `storage.rules` block refuses `image/svg+xml`
 * outright, mirrored here so the author is told in a sentence.
 *
 * `accept="image/*"` includes SVG and the picker offers it, so without this
 * the file is compressed, uploaded, refused at the network, and the raw
 * Firebase permission string is what lands in the error line. The rule is
 * still the enforcement; this is only the part that makes the refusal legible.
 *
 * SCOPED, not universal. Only `worksheet-images` carries the rule, because a
 * worksheet image is readable by every signed-in account and SVG is a document
 * format that can carry script. The other prefixes accept SVG today, and
 * refusing it for all of them would be a behaviour change on the newsletter,
 * events, courses and email-design editors that nobody asked for.
 */
const SVG_REFUSING_PREFIXES = new Set(["worksheet-images"]);

function safeFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
}

export default function ImageUpload({
  draftId,
  storagePrefix = "newsletter-images",
  currentUrl,
  currentAlt = "",
  currentCaption = "",
  onChange,
  disabled,
  enableCrop,
  hideTextFields,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [alt, setAlt] = useState(currentAlt);
  const [caption, setCaption] = useState(currentCaption);
  const [pending, setPending] = useState<{ src: string; file: File } | null>(null);

  async function processFile(file: File) {
    try {
      setState({ kind: "compressing" });
      const compressed = await imageCompression(file, {
        maxSizeMB: MAX_SIZE_MB,
        maxWidthOrHeight: MAX_DIMENSION,
        useWebWorker: true,
        // Prefer the original type so PNGs with transparency stay PNGs.
        fileType: file.type.startsWith("image/") ? file.type : "image/jpeg",
      });

      setState({ kind: "uploading", progress: 0 });
      const path = `${storagePrefix}/${draftId}/${Date.now()}-${safeFileName(compressed.name)}`;
      const storageRef = ref(getClientStorage(), path);
      await uploadBytes(storageRef, compressed, {
        contentType: compressed.type,
        // Let emails cache the image in the recipient's client.
        cacheControl: "public, max-age=31536000, immutable",
      });
      const url = await getDownloadURL(storageRef);
      onChange({ url, alt, caption: caption || undefined, storagePath: path });
      setState({ kind: "idle" });
    } catch (err) {
      console.error(err);
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the input straight away so re-picking the same file still fires.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setState({ kind: "error", message: "Please pick an image file." });
      return;
    }

    if (file.type === "image/svg+xml" && SVG_REFUSING_PREFIXES.has(storagePrefix)) {
      setState({
        kind: "error",
        message: "SVG files cannot be used here. Please pick a JPG, PNG, GIF or WebP.",
      });
      return;
    }

    if (enableCrop) {
      // Defer compress + upload until the organiser confirms a crop.
      setPending({ src: URL.createObjectURL(file), file });
      return;
    }
    await processFile(file);
  }

  function discardPending() {
    setPending((p) => {
      if (p) URL.revokeObjectURL(p.src);
      return null;
    });
  }

  async function onCropConfirmed(file: File) {
    const prev = pending;
    setPending(null);
    await processFile(file);
    if (prev) URL.revokeObjectURL(prev.src);
  }

  async function onCropSkipped() {
    const prev = pending;
    setPending(null);
    if (prev) {
      await processFile(prev.file);
      URL.revokeObjectURL(prev.src);
    }
  }

  function onAltChange(next: string) {
    setAlt(next);
    if (currentUrl) {
      onChange({ url: currentUrl, alt: next, caption: caption || undefined });
    }
  }

  function onCaptionChange(next: string) {
    setCaption(next);
    if (currentUrl) {
      onChange({ url: currentUrl, alt, caption: next || undefined });
    }
  }

  function onClear() {
    setAlt("");
    setCaption("");
    onChange({ url: "", alt: "", caption: undefined });
  }

  const busy = state.kind === "compressing" || state.kind === "uploading";

  return (
    <div className={styles.wrap}>
      {currentUrl ? (
        <div className={styles.preview}>
          {/* Admin-only preview of a user-uploaded Firebase Storage image:
              next/image optimization isn't worth the domain config cost here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={currentUrl} alt={alt || "preview"} className={styles.previewImg} />
          <div className={styles.previewActions}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || busy}
            >
              Replace
            </Button>
            <button
              type="button"
              onClick={onClear}
              disabled={disabled || busy}
              className={styles.removeBtn}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.dropzone}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || busy}
        >
          {state.kind === "compressing" ? (
            <span className={styles.dropzoneText}>Compressing…</span>
          ) : state.kind === "uploading" ? (
            <span className={styles.dropzoneText}>Uploading…</span>
          ) : (
            <>
              <span className={styles.dropzoneTitle}>Click to upload an image</span>
              <span className={styles.dropzoneHint}>
                JPG, PNG, GIF, or WebP · Auto-compressed to ≤ {MAX_SIZE_MB}MB, ≤{" "}
                {MAX_DIMENSION}px wide
              </span>
            </>
          )}
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onFile}
        style={{ display: "none" }}
      />

      {state.kind === "error" && <p className={styles.error}>{state.message}</p>}

      {currentUrl && !hideTextFields && (
        <div className={styles.fields}>
          <label className={styles.fieldLabel}>
            <span>
              Alt text <span className={styles.required}>*</span>
            </span>
            <input
              type="text"
              value={alt}
              onChange={(e) => onAltChange(e.target.value)}
              placeholder="Describe this image for people who can't see it"
              disabled={disabled}
              className={styles.fieldInput}
              required
            />
            <span className={styles.fieldHint}>
              Used by screen readers and when an email client blocks images. Required.
            </span>
          </label>
          <label className={styles.fieldLabel}>
            <span>Caption (optional)</span>
            <input
              type="text"
              value={caption}
              onChange={(e) => onCaptionChange(e.target.value)}
              placeholder="A short caption shown under the image"
              disabled={disabled}
              className={styles.fieldInput}
            />
          </label>
        </div>
      )}

      {pending && (
        <ImageCropModal
          src={pending.src}
          fileName={pending.file.name}
          onCropped={onCropConfirmed}
          onSkip={onCropSkipped}
          onCancel={discardPending}
        />
      )}
    </div>
  );
}
