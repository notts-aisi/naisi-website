/**
 * Attachment metadata at /tasks/{taskId}/attachments/{attachmentId}.
 * Binary lives in Firebase Storage at tasks/{taskId}/{attachmentId}/{filename}.
 * Rules at [firestore.rules:163-179] + storage.rules.
 */
export const ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024, // 10 MB — matches storage.rules
  allowedMimePrefixes: [
    "image/",
    "application/pdf",
    "text/",
    "application/vnd.openxmlformats",
    "application/msword",
    "application/zip",
  ],
} as const;

/**
 * Keep only the storage paths that genuinely belong to `taskId`.
 *
 * `storagePath` is written by the CLIENT (attachmentMutations.ts builds
 * `tasks/{taskId}/{attachmentId}/{name}`), and the three task-delete routes
 * hand these strings to `bucket.file(path).delete()` through the Admin SDK —
 * which bypasses storage.rules entirely. An unfiltered value therefore let any
 * signed-in account point an attachment on a throwaway personal task at
 * `event-images/...`, `newsletter-images/...` or another task's blobs and have
 * the server delete arbitrary objects anywhere in the bucket.
 *
 * firestore.rules now pins the field on create, but this check is deliberately
 * kept as well: rules on this project deploy out of band from code, existing
 * documents predate the pin, and the blast radius of getting it wrong is the
 * whole bucket. Belt and braces.
 */
export function ownedStoragePaths(taskId: string, raw: unknown[]): string[] {
  const prefix = `tasks/${taskId}/`;
  return raw.filter(
    (p): p is string =>
      typeof p === "string" &&
      p.startsWith(prefix) &&
      // No traversal, no absolute paths, no sneaking back up a level.
      !p.includes("..") &&
      p.length > prefix.length,
  );
}

export type AttachmentDoc = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedByUid: string;
  uploadedAt: Date | null;
  /** Scopes the attachment to a specific subtask when non-null. Task-level
   *  attachments (the original behaviour) store `null` and show up only in
   *  `TaskDetailModal`'s attachment section. Subtask-scoped attachments
   *  show up in that subtask's detail modal instead. Storage path is
   *  unchanged regardless — scoping lives purely in the metadata. */
  subtaskId: string | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

export function normalizeAttachment(id: string, data: Raw): AttachmentDoc {
  return {
    id,
    filename: (data.filename as string) ?? "file",
    contentType: (data.contentType as string) ?? "application/octet-stream",
    sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
    storagePath: (data.storagePath as string) ?? "",
    uploadedByUid: (data.uploadedByUid as string) ?? "",
    uploadedAt: tsToDate(data.uploadedAt),
    // Pre-migration attachments have no `subtaskId` field — default to null
    // (task-level) so they stay visible in `TaskDetailModal` like before.
    subtaskId: typeof data.subtaskId === "string" ? data.subtaskId : null,
  };
}

export function isMimeAllowed(contentType: string): boolean {
  return ATTACHMENT_LIMITS.allowedMimePrefixes.some((p) => contentType.startsWith(p));
}
