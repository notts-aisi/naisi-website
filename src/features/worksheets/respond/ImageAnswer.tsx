"use client";

import { useRef, useState } from "react";
import imageCompression from "browser-image-compression";
import Button from "@/components/ui/Button";
import {
  imageAllowanceOf,
  type WorksheetAnswer,
  type WorksheetQuestion,
} from "@/lib/firestore/worksheets";
import styles from "./WorksheetQuestionField.module.css";

/**
 * The answer to an `imageUpload` question: up to `upload.maxImages` pictures,
 * each compressed in the browser and then POSTed to the upload route.
 *
 * ── WHY THE ROUTE AND NOT A CLIENT-DIRECT STORAGE WRITE ─────────────────────
 * `storage.rules` gives `worksheet-uploads/{circulationId}/{uid}/` no client
 * write at all. The file goes through
 * `POST /api/worksheets/circulations/{id}/upload`, which checks the MAGIC
 * BYTES rather than the declared type (PNG, JPEG, GIF and WebP; SVG refused
 * outright, because an SVG is a script that renders as a picture), enforces
 * the 5 MB ceiling on what actually arrived, and writes with the Admin SDK.
 * Compression here is a courtesy to the recipient's data allowance, never a
 * safety measure: nothing the browser says about a file is trusted by the
 * thing that stores it.
 *
 * ── GIFS ARE NOT RECOMPRESSED ───────────────────────────────────────────────
 * `browser-image-compression` works by drawing to a canvas, and a canvas holds
 * one frame, so a compressed GIF arrives as a still. An animation somebody
 * chose to submit is the content, not the packaging. GIFs are sent as they
 * are, and refused here with a sentence when they are over the route's own
 * limit rather than being quietly flattened.
 *
 * ── REMOVING AN IMAGE LEAVES THE FILE IN THE BUCKET ─────────────────────────
 * Remove takes the pair off the answer; there is no delete route in v1, so the
 * blob stays. That is a known, bounded cost (a recipient's own uploads, capped
 * at four per question) rather than an oversight: a delete endpoint a
 * recipient can call is one more way to lose a submitted answer, and the sweep
 * belongs with the circulation's own deletion when that is built.
 */

/** What the route accepts, and what the picker offers. Kept as one list. */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(",");

/** The route's ceiling, mirrored so an oversized GIF is refused before it
 *  spends somebody's data getting there. */
const MAX_BYTES = 5 * 1024 * 1024;
const COMPRESS_MAX_MB = 1.5;
const COMPRESS_MAX_DIMENSION = 1600;

type UploadState =
  | { kind: "idle" }
  | { kind: "compressing" }
  | { kind: "uploading" }
  | { kind: "error"; message: string };

type Props = {
  question: WorksheetQuestion;
  answer: WorksheetAnswer | undefined;
  onChange: (next: WorksheetAnswer) => void;
  disabled?: boolean;
  /** Bound to this question by the field above. Absent means read-only. */
  onUpload?: (file: File) => Promise<{ url: string; storagePath: string }>;
  /**
   * Store the answer NOW rather than on the autosave's next beat.
   *
   * An image is in the bucket before it is in the answer, so a tab closed
   * inside the 900ms debounce leaves a blob nothing points at and a recipient
   * looking at a question they believe they answered. Every other control on
   * this page can afford the wait, because retyping a sentence costs a
   * sentence; re-taking a photograph over a phone connection does not.
   */
  onCommit?: () => void;
};

export default function ImageAnswer({
  question,
  answer,
  onChange,
  disabled,
  onUpload,
  onCommit,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });

  const images = answer?.type === "images" ? answer.images : [];
  const allowance = imageAllowanceOf(question);
  const busy = state.kind === "compressing" || state.kind === "uploading";
  const full = images.length >= allowance;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared straight away so picking the same file twice still fires.
    if (inputRef.current) inputRef.current.value = "";
    if (!file || !onUpload || full) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setState({
        kind: "error",
        message: "That file is not a PNG, JPEG, GIF or WebP image.",
      });
      return;
    }

    try {
      let toSend = file;
      if (file.type === "image/gif") {
        // See the module comment: an animation survives or it is refused.
        if (file.size > MAX_BYTES) {
          setState({
            kind: "error",
            message: "That GIF is over 5 MB. Try a shorter or smaller one.",
          });
          return;
        }
      } else {
        setState({ kind: "compressing" });
        toSend = await imageCompression(file, {
          maxSizeMB: COMPRESS_MAX_MB,
          maxWidthOrHeight: COMPRESS_MAX_DIMENSION,
          useWebWorker: true,
          // Keeps a PNG a PNG, so transparency survives the pass.
          fileType: file.type,
        });
      }

      setState({ kind: "uploading" });
      const stored = await onUpload(toSend);
      onChange({ type: "images", images: [...images, stored] });
      // The page pushes the answer to its autosave synchronously inside
      // `onChange`, so this lands what was just queued rather than racing it.
      onCommit?.();
      setState({ kind: "idle" });
    } catch (err) {
      // The route's own sentence when it answered one, and never a bare
      // "upload failed": the reasons it refuses (wrong type, too big, frozen
      // response) are all things the recipient can act on.
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "That image did not upload.",
      });
    }
  }

  function removeAt(index: number) {
    onChange({ type: "images", images: images.filter((_, i) => i !== index) });
    // Stored straight away for the same reason as an upload: a removal left in
    // the debounce window comes back on the next load, which reads as the
    // Remove button not working.
    onCommit?.();
  }

  return (
    <>
      {images.length > 0 && (
        <div className={styles.thumbs}>
          {images.map((image, index) => (
            <div key={image.storagePath} className={styles.thumb}>
              {/* Storage download URL for an image this person uploaded
                  themselves. next/image is not used anywhere in this repo. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={`Your image ${index + 1}`}
                className={styles.thumbImg}
              />
              <button
                type="button"
                className={styles.thumbRemove}
                onClick={() => removeAt(index)}
                disabled={disabled || busy}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {onUpload && (
        <div className={styles.uploadRow}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || busy || full}
          >
            {state.kind === "compressing"
              ? "Preparing…"
              : state.kind === "uploading"
                ? "Uploading…"
                : images.length > 0
                  ? "Add another image"
                  : "Add an image"}
          </Button>
          <p className={styles.uploadHint}>
            {full
              ? `You have added all ${allowance} image${allowance === 1 ? "" : "s"}.`
              : `PNG, JPEG, GIF or WebP · up to ${allowance} image${allowance === 1 ? "" : "s"}`}
          </p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className={styles.hiddenInput}
        onChange={onFile}
        disabled={disabled || busy || full}
      />

      {state.kind === "error" && (
        <p className={styles.uploadError} role="alert">
          {state.message}
        </p>
      )}
    </>
  );
}
