/**
 * Comment docs live at /tasks/{taskId}/comments/{commentId}.
 *
 * Body is stored as markdown with mention tokens encoded as
 * `@[Display Name](uid:abc123)`. See [src/features/tasks/lib/comments/markdown.ts]
 * for parse + serialize helpers. `mentions[]` mirrors the UIDs referenced by
 * those tokens so Firestore rules + the /notify API route can read them
 * without re-parsing the body.
 *
 * Field shape matches the existing Firestore rules in
 * [firestore.rules:124-145]. Keep the two in sync.
 */
export const COMMENT_FIELD_LIMITS = {
  bodyMarkdown: 2000,
  maxMentions: 10,
} as const;

export type CommentDoc = {
  id: string;
  authorUid: string;
  bodyMarkdown: string;
  mentions: string[];
  /** Phase 3 (2026-04-24): comments can be scoped to a specific subtask.
   *  `null` = task-level comment (the original behaviour). A string value
   *  pins the comment to the named subtask — rendered inside its detail
   *  modal, omitted from the task-level thread. */
  subtaskId: string | null;
  createdAt: Date | null;
  editedAt: Date | null;
  deleted: boolean;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((s): s is string => typeof s === "string");
}

export function normalizeComment(id: string, data: Raw): CommentDoc {
  return {
    id,
    authorUid: (data.authorUid as string) ?? "",
    bodyMarkdown: (data.bodyMarkdown as string) ?? "",
    mentions: stringArray(data.mentions),
    subtaskId: typeof data.subtaskId === "string" ? data.subtaskId : null,
    createdAt: tsToDate(data.createdAt),
    editedAt: tsToDate(data.editedAt),
    deleted: Boolean(data.deleted),
  };
}
