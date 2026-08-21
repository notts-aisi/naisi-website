/**
 * `courseProgress/{runId}__{uid}__{itemId}` — one member's state on one
 * check-offable item (a material or a checklist item). This is THE one
 * client-direct write in the courses feature: the check-off hot path commits
 * instantly via the client SDK, and the rules fully express the invariant —
 * the doc id must equal `runId + '__' + auth.uid + '__' + itemId`, so a
 * member can only ever address their own rows, structurally.
 *
 * All member-authored content here (`publicComment`, `privateNote`) is typed
 * `string` — plain text, never `Block[]` — and is rendered as text nodes
 * only. That typing is the XSS boundary for cohort-visible content.
 *
 * Optional fields are OMITTED when absent, never null: the rules assert
 * "absent-or-valid" per key, and `null` would need its own branch in every
 * clause. `hasPublicComment` is the one derived field that is ALWAYS present:
 * it's the queryable mirror of "publicComment exists" (Firestore can't query
 * field-existence), and the rules pin it to the actual comment so the
 * comments lane can trust a `where("hasPublicComment", "==", true)` filter.
 */

export type ProgressItemKind = "material" | "checklist";

export const PROGRESS_LIMITS = {
  publicComment: 1000,
  privateNote: 2000,
} as const;

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export type CourseProgressDoc = {
  /** Firestore doc id: `courseProgressId(runId, uid, itemId)`. */
  id: string;
  runId: string;
  uid: string;
  weekNumber: number;
  itemKind: ProgressItemKind;
  itemId: string;
  completed: boolean;
  completedAt?: Date;
  /** Star rating, integer 1–5. */
  rating?: number;
  /** Visible to everyone on the run. Plain text (see module comment). */
  publicComment?: string;
  /**
   * ALWAYS present — the queryable mirror of `publicComment` being set.
   * Enforced equal to (publicComment present && non-empty) by both
   * `buildProgressWrite` and the rules, so they can never disagree.
   */
  hasPublicComment: boolean;
  /** Visible to facilitators + admins only. Plain text. */
  privateNote?: string;
  /**
   * Set by the admin moderation route when a public comment is hidden.
   * Client writes must carry these through VERBATIM (rules-pinned) — a
   * member can't launder a moderated comment by re-saving the row.
   */
  moderatedByUid?: string;
  moderatedAt?: Date;
  updatedAt?: Date | null;
};

/**
 * Deterministic doc id binding (run, member, item) — the rules compare the
 * written id against `runId + '__' + request.auth.uid + '__' + itemId`, which
 * is what makes own-row-only writes structural rather than query-policed.
 *
 * CONSTRUCT-ONLY — NEVER PARSE. `runId`/`uid`/`itemId` are stored as fields;
 * splitting the id on `__` is ambiguous (runIds from `slugId` already contain
 * `__`). Anything that needs the parts reads the fields.
 */
export function courseProgressId(runId: string, uid: string, itemId: string): string {
  return `${runId}__${uid}__${itemId}`;
}

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asRating(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const rounded = Math.round(v);
  if (rounded < RATING_MIN || rounded > RATING_MAX) return null;
  return rounded;
}

export function normalizeCourseProgress(id: string, data: Raw): CourseProgressDoc {
  const doc: CourseProgressDoc = {
    id,
    runId: str(data.runId),
    uid: str(data.uid),
    weekNumber:
      typeof data.weekNumber === "number" && Number.isFinite(data.weekNumber)
        ? Math.floor(data.weekNumber)
        : 0,
    itemKind: data.itemKind === "checklist" ? "checklist" : "material",
    itemId: str(data.itemId),
    completed: data.completed === true,
    hasPublicComment: data.hasPublicComment === true,
    updatedAt: tsToDate(data.updatedAt),
  };
  const completedAt = tsToDate(data.completedAt);
  if (completedAt) doc.completedAt = completedAt;
  const rating = asRating(data.rating);
  if (rating !== null) doc.rating = rating;
  if (typeof data.publicComment === "string" && data.publicComment) {
    doc.publicComment = data.publicComment;
  }
  if (typeof data.privateNote === "string" && data.privateNote) {
    doc.privateNote = data.privateNote;
  }
  if (typeof data.moderatedByUid === "string" && data.moderatedByUid) {
    doc.moderatedByUid = data.moderatedByUid;
    const moderatedAt = tsToDate(data.moderatedAt);
    if (moderatedAt) doc.moderatedAt = moderatedAt;
  }
  return doc;
}

export type ProgressWriteInput = {
  runId: string;
  uid: string;
  weekNumber: number;
  itemKind: ProgressItemKind;
  itemId: string;
  completed: boolean;
  /**
   * The completion instant — pass the client SDK's `serverTimestamp()`
   * sentinel (or a Date). Included only while `completed` is true.
   */
  completedAt?: unknown;
  rating?: number;
  publicComment?: string;
  privateNote?: string;
  /**
   * EXISTING moderation fields from the current doc, carried through
   * verbatim — the rules pin them, so dropping them would fail the write.
   */
  moderatedByUid?: string;
  moderatedAt?: unknown;
};

/**
 * Build the full-doc payload for the client-direct progress write (the
 * check-off / rating / comment save all go through here). Clamps and trims
 * everything, omits empty optionals (never null, never undefined), and
 * derives `hasPublicComment` from the trimmed comment — the ONE place the
 * mirror is computed, so the client mutation and the rules' pin can't drift.
 */
export function buildProgressWrite(input: ProgressWriteInput): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    runId: input.runId,
    uid: input.uid,
    weekNumber: Math.floor(input.weekNumber),
    itemKind: input.itemKind,
    itemId: input.itemId,
    completed: Boolean(input.completed),
  };
  if (input.completed && input.completedAt !== undefined) {
    doc.completedAt = input.completedAt;
  }
  const rating = asRating(input.rating);
  if (rating !== null) doc.rating = rating;
  const publicComment = (input.publicComment ?? "")
    .trim()
    .slice(0, PROGRESS_LIMITS.publicComment);
  // hasPublicComment === (publicComment present && non-empty), always.
  doc.hasPublicComment = publicComment.length > 0;
  if (publicComment) doc.publicComment = publicComment;
  const privateNote = (input.privateNote ?? "")
    .trim()
    .slice(0, PROGRESS_LIMITS.privateNote);
  if (privateNote) doc.privateNote = privateNote;
  if (input.moderatedByUid) {
    doc.moderatedByUid = input.moderatedByUid;
    if (input.moderatedAt !== undefined) doc.moderatedAt = input.moderatedAt;
  }
  return doc;
}
