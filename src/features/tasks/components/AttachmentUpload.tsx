"use client";

import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import { ATTACHMENT_LIMITS } from "@/lib/firestore/taskAttachments";
import { uploadAttachment } from "../attachmentMutations";

type Props = {
  taskId: string;
};

export default function AttachmentUpload({ taskId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      await uploadAttachment({
        taskId,
        file,
        onProgress: (frac) => setProgress(Math.round(frac * 100)),
      });
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      setProgress(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? `Uploading… ${progress}%` : "Attach file"}
        </Button>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-subtle)" }}>
          Max {ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB
        </span>
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={handlePick}
          // Intentionally no `accept` — Storage rules enforce the MIME list
          // server-side. Keeping the picker open so the rejection error is
          // clear when a wrong type is tried.
        />
      </div>
      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "var(--text-xs)", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
