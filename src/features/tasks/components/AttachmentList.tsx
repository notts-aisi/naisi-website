"use client";

import { getDownloadURL, getStorage, ref as storageRef } from "firebase/storage";
import { useEffect, useState } from "react";
import type { AttachmentDoc } from "@/lib/firestore/taskAttachments";
import type { UserDoc } from "@/lib/firestore/users";
import { deleteAttachment } from "../attachmentMutations";

type Props = {
  taskId: string;
  attachments: AttachmentDoc[];
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function AttachmentList({
  taskId,
  attachments,
  users,
  viewerUid,
  viewerIsAdmin,
}: Props) {
  if (attachments.length === 0) {
    return (
      <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
        No attachments yet.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {attachments.map((a) => (
        <AttachmentRow
          key={a.id}
          taskId={taskId}
          attachment={a}
          users={users}
          viewerUid={viewerUid}
          viewerIsAdmin={viewerIsAdmin}
        />
      ))}
    </div>
  );
}

function AttachmentRow({
  taskId,
  attachment,
  users,
  viewerUid,
  viewerIsAdmin,
}: {
  taskId: string;
  attachment: AttachmentDoc;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
}) {
  const [downloadURL, setDownloadURL] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await getDownloadURL(storageRef(getStorage(), attachment.storagePath));
        if (!cancelled) setDownloadURL(url);
      } catch (err) {
        console.warn("AttachmentList: failed to resolve download URL:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.storagePath]);

  const uploader = users.find((u) => u.uid === attachment.uploadedByUid);
  const uploaderName = uploader?.displayName ?? uploader?.email ?? attachment.uploadedByUid;
  const canDelete = viewerIsAdmin || attachment.uploadedByUid === viewerUid;

  async function handleDelete() {
    if (!window.confirm(`Delete "${attachment.filename}"?`)) return;
    setBusy(true);
    try {
      await deleteAttachment(taskId, attachment.id, attachment.storagePath);
    } catch (err) {
      console.error(err);
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "0.5rem 0.75rem",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--text-sm)",
      }}
    >
      <span aria-hidden style={{ fontSize: "var(--text-md)" }}>
        📎
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {downloadURL ? (
          <a
            href={downloadURL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--color-accent)", fontWeight: 500 }}
          >
            {attachment.filename}
          </a>
        ) : (
          <span>{attachment.filename}</span>
        )}
        <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-subtle)" }}>
          {formatBytes(attachment.sizeBytes)} · uploaded by {uploaderName}
          {attachment.uploadedAt && ` · ${attachment.uploadedAt.toLocaleDateString()}`}
        </div>
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          aria-label="Delete attachment"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--color-danger)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
