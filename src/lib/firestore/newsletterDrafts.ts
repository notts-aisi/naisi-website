import { sanitizeBlocks, type Block } from "./newsletterBlocks";

export type DraftStatus = "draft" | "pending" | "approved" | "sent" | "rejected";

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  draft: "Draft",
  pending: "Pending review",
  approved: "Approved",
  sent: "Sent",
  rejected: "Rejected",
};

export type NewsletterDraft = {
  id: string;
  subject: string;
  /** Legacy: the original plain-markdown body. Kept as a backup once blocks are populated. */
  bodyMarkdown: string;
  /** Structured body — ordered blocks. Takes precedence over bodyMarkdown if non-empty. */
  blocks: Block[];
  status: DraftStatus;
  authorUid: string;
  authorDisplayName?: string | null;
  reviewerNotes?: string | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  sentAt?: Date | null;
  /** Total emails actually sent (an opted-in Gmail + uni address counts as 2). */
  sentCount?: number | null;
  /** Distinct subscribers who received at least one email. */
  subscribersReached?: number | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function asStatus(v: unknown): DraftStatus {
  const ok = ["draft", "pending", "approved", "sent", "rejected"] as const;
  return ok.includes(v as DraftStatus) ? (v as DraftStatus) : "draft";
}

export function normalizeDraft(id: string, data: Raw): NewsletterDraft {
  return {
    id,
    subject: (data.subject as string) ?? "",
    bodyMarkdown: (data.bodyMarkdown as string) ?? "",
    blocks: sanitizeBlocks(data.blocks),
    status: asStatus(data.status),
    authorUid: (data.authorUid as string) ?? "",
    authorDisplayName: (data.authorDisplayName as string | null | undefined) ?? null,
    reviewerNotes: (data.reviewerNotes as string | null | undefined) ?? null,
    approvedBy: (data.approvedBy as string | null | undefined) ?? null,
    approvedAt: tsToDate(data.approvedAt),
    sentAt: tsToDate(data.sentAt),
    sentCount: typeof data.sentCount === "number" ? (data.sentCount as number) : null,
    subscribersReached:
      typeof data.subscribersReached === "number"
        ? (data.subscribersReached as number)
        : null,
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
  };
}

export const SUBJECT_MAX = 120;
export const BODY_MAX = 20_000;
