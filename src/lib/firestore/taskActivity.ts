/**
 * Activity log entries at /tasks/{taskId}/activity/{entryId}.
 * Append-only — rules at [firestore.rules:147-161] forbid update/delete.
 *
 * Kinds map to the mutations that produce them (see
 * src/features/tasks/taskMutations.ts). The server-written kinds
 * (`sent_for_review`) originate from the /api/tasks/[id]/send-for-review
 * route via Admin SDK.
 */
export type ActivityKind =
  | "created"
  | "status_changed"
  | "assignee_added"
  | "assignee_removed"
  | "reviewer_added"
  | "reviewer_removed"
  | "subtask_added"
  | "subtask_done"
  | "subtask_blocked_changed"
  | "attachment_added"
  | "comment_added"
  | "sent_for_review"
  | "block_created"
  | "block_renamed"
  | "block_deleted"
  | "block_sealed"
  | "block_force_sealed"
  | "block_unsealed"
  | "subtask_force_sealed"
  | "subtask_unsealed";

export type ActivityPayload = Record<string, unknown>;

export type ActivityDoc = {
  id: string;
  kind: ActivityKind;
  actorUid: string;
  createdAt: Date | null;
  payload: ActivityPayload;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

const KNOWN_KINDS: ActivityKind[] = [
  "created",
  "status_changed",
  "assignee_added",
  "assignee_removed",
  "reviewer_added",
  "reviewer_removed",
  "subtask_added",
  "subtask_done",
  "subtask_blocked_changed",
  "attachment_added",
  "comment_added",
  "sent_for_review",
  "block_created",
  "block_renamed",
  "block_deleted",
  "block_sealed",
  "block_force_sealed",
  "block_unsealed",
  "subtask_force_sealed",
  "subtask_unsealed",
];

export function normalizeActivity(id: string, data: Raw): ActivityDoc {
  const rawKind = typeof data.kind === "string" ? data.kind : null;
  const kind: ActivityKind = (KNOWN_KINDS as string[]).includes(rawKind ?? "")
    ? (rawKind as ActivityKind)
    : "created";
  const payload =
    data.payload && typeof data.payload === "object"
      ? (data.payload as ActivityPayload)
      : {};
  return {
    id,
    kind,
    actorUid: (data.actorUid as string) ?? "",
    createdAt: tsToDate(data.createdAt),
    payload,
  };
}
