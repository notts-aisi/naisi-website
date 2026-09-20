"use client";

import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import { SOURCE_SHEET_LIMITS, type SourceSheetFile } from "@/lib/firestore/sourceSheets";
import { uploadSourceSheetFile } from "./sourceSheetMutations";
import styles from "./editor.module.css";

type Props = {
  slug: string;
  current: SourceSheetFile | null;
  /** Called with what the document should now store, or null to clear it. */
  onChange: (next: SourceSheetFile | null) => void | Promise<void>;
  disabled?: boolean;
};

type State =
  | { kind: "idle" }
  | { kind: "uploading"; progress: number }
  | { kind: "error"; message: string };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The PDF slot. Its own component rather than a second `ImageUpload`, for two
 * reasons that both bite:
 *
 *  - `ImageUpload.processFile` runs `browser-image-compression` on whatever it
 *    is handed, unconditionally, and its picker is `accept="image/*"`. Neither
 *    is something a PDF survives.
 *  - The upload has to set `contentDisposition` on the object so the link on
 *    the public page downloads rather than opening a tab. That is metadata
 *    written at upload time and it belongs on the PDF only.
 *
 * The size is checked before the upload starts so the refusal is a sentence
 * naming the limit, not the raw Firebase permission string the storage rule
 * would return.
 */
export default function SourceFileUpload({ slug, current, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  const busy = state.kind === "uploading";

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared straight away so picking the same file twice still fires.
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;

    if (file.type !== "application/pdf") {
      setState({ kind: "error", message: "Please choose a PDF." });
      return;
    }
    if (file.size > SOURCE_SHEET_LIMITS.fileBytes) {
      setState({
        kind: "error",
        message: `That PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
          SOURCE_SHEET_LIMITS.fileBytes / 1024 / 1024
        } MB, so export it smaller and try again.`,
      });
      return;
    }

    setState({ kind: "uploading", progress: 0 });
    try {
      const uploaded = await uploadSourceSheetFile(slug, file, (fraction) =>
        setState({ kind: "uploading", progress: fraction }),
      );
      await onChange(uploaded);
      setState({ kind: "idle" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Upload failed.",
      });
    }
  }

  async function onRemove() {
    if (!window.confirm("Remove this PDF? The file is deleted and the link stops working.")) {
      return;
    }
    setState({ kind: "idle" });
    await onChange(null);
  }

  return (
    <div className={styles.uploadWrap}>
      {current ? (
        <div className={styles.filePill}>
          <span className={styles.fileName}>{current.filename}</span>
          <span className={styles.fileMeta}>
            PDF{formatBytes(current.sizeBytes) ? ` · ${formatBytes(current.sizeBytes)}` : ""}
          </span>
          <div className={styles.fileActions}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
            >
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={disabled || busy}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.dropzone}
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy}
        >
          {busy ? (
            <span className={styles.dropzoneText}>
              Uploading… {Math.round(state.progress * 100)}%
            </span>
          ) : (
            <>
              <span className={styles.dropzoneTitle}>Click to upload a PDF</span>
              <span className={styles.dropzoneHint}>
                One file, up to {SOURCE_SHEET_LIMITS.fileBytes / 1024 / 1024}MB. It may
                have several pages.
              </span>
            </>
          )}
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        onChange={onPick}
        style={{ display: "none" }}
      />

      {state.kind === "error" && <p className={styles.error}>{state.message}</p>}
    </div>
  );
}
