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

export type AttachmentDoc = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedByUid: string;
  uploadedAt: Date | null;
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
  };
}

export function isMimeAllowed(contentType: string): boolean {
  return ATTACHMENT_LIMITS.allowedMimePrefixes.some((p) => contentType.startsWith(p));
}
