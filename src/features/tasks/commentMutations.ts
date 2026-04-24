"use client";

import {
  collection,
  deleteDoc,
  doc,
  increment,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import { COMMENT_FIELD_LIMITS } from "@/lib/firestore/comments";
import { slugId } from "@/lib/firestore/slugId";
import { queueActivity } from "./activityLog";

/**
 * Build a slug source from a comment body: strip mention tokens down to
 * `@Name`, take the first ~6 words. Prefixing subcomments with `sub-` is the
 * cheap way to distinguish them from task-level comments at a glance in the
 * Firebase Console — a subcomment's `subtaskId` field is still the precise
 * reference, this is just scannability.
 */
function commentSlugSource(bodyMarkdown: string, subtaskId: string | null): string {
  const stripped = bodyMarkdown.replace(/@\[([^\]]+)\]\(uid:[^)]+\)/g, "@$1");
  const firstWords = stripped.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return subtaskId ? `sub-${firstWords}` : firstWords;
}

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export type AddCommentInput = {
  taskId: string;
  bodyMarkdown: string;
  mentions: string[];
  /** Phase 3 (2026-04-24): scope a comment to a specific subtask. `null` or
   *  omitted = task-level (the original behaviour). Subtask comments
   *  render inside the subtask's detail modal and don't appear in the
   *  task-level thread. */
  subtaskId?: string | null;
};

/**
 * Write a new comment + increment parent.commentCount + log `comment_added`
 * activity in one atomic batch. Returns the new comment id so the caller can
 * optimistically jump to it or pass it to the /notify API route.
 */
export async function addComment(input: AddCommentInput): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();

  const body = input.bodyMarkdown.trim();
  if (!body) throw new Error("Comment body required");
  if (body.length > COMMENT_FIELD_LIMITS.bodyMarkdown) {
    throw new Error(
      `Comment must be ${COMMENT_FIELD_LIMITS.bodyMarkdown} characters or fewer`,
    );
  }
  const mentions = Array.from(new Set(input.mentions)).slice(
    0,
    COMMENT_FIELD_LIMITS.maxMentions,
  );

  // addDoc doesn't play with writeBatch, so we pre-generate the comment ref
  // via doc(collection(...)) and use batch.set on it. Keeps the commentCount
  // increment + activity entry atomic with the comment write.
  const subtaskId = input.subtaskId ?? null;
  const commentRef = doc(
    collection(db, "tasks", input.taskId, "comments"),
    slugId(commentSlugSource(body, subtaskId)),
  );
  const batch = writeBatch(db);
  batch.set(commentRef, {
    authorUid: uid,
    bodyMarkdown: body,
    mentions,
    subtaskId,
    createdAt: serverTimestamp(),
    editedAt: null,
    deleted: false,
  });
  batch.update(doc(db, "tasks", input.taskId), {
    commentCount: increment(1),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, input.taskId, "comment_added", uid, {
    commentId: commentRef.id,
    subtaskId,
  });
  await batch.commit();
  return commentRef.id;
}

export async function updateComment(
  taskId: string,
  commentId: string,
  nextBody: string,
  nextMentions: string[],
): Promise<void> {
  const db = getClientDb();
  const body = nextBody.trim();
  if (!body) throw new Error("Comment body required");
  if (body.length > COMMENT_FIELD_LIMITS.bodyMarkdown) {
    throw new Error(
      `Comment must be ${COMMENT_FIELD_LIMITS.bodyMarkdown} characters or fewer`,
    );
  }
  const mentions = Array.from(new Set(nextMentions)).slice(
    0,
    COMMENT_FIELD_LIMITS.maxMentions,
  );
  await updateDoc(doc(db, "tasks", taskId, "comments", commentId), {
    bodyMarkdown: body,
    mentions,
    editedAt: serverTimestamp(),
  });
}

/**
 * Soft-delete — tombstone with `deleted: true`. The comment row renders as
 * "(deleted)" in the feed so thread continuity is preserved. Firestore rules
 * only allow the author to flip `deleted`; full doc deletion is admin-only.
 */
export async function softDeleteComment(
  taskId: string,
  commentId: string,
): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "tasks", taskId, "comments", commentId), {
    deleted: true,
    // Null out the body so the tombstone render can't accidentally leak it.
    bodyMarkdown: "",
    mentions: [],
    editedAt: serverTimestamp(),
  });
}

/** Hard-delete. Admin-only per rules. Also decrements parent.commentCount. */
export async function hardDeleteComment(
  taskId: string,
  commentId: string,
): Promise<void> {
  const db = getClientDb();
  await deleteDoc(doc(db, "tasks", taskId, "comments", commentId));
  await updateDoc(doc(db, "tasks", taskId), {
    commentCount: increment(-1),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Fallback creator for ad-hoc activity entries that don't fit a mutation —
 * e.g. when server-side flows need a client-side mirror. Returns the doc id.
 */
export async function appendFreeformComment(
  taskId: string,
  bodyMarkdown: string,
): Promise<string> {
  return addComment({ taskId, bodyMarkdown, mentions: [] });
}
