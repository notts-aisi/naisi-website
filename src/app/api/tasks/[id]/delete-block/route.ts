import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type Payload = { blockId?: unknown };

/**
 * Cascade-delete a block: every completion + reviewer-signoff subtask in
 * that block, every comment scoped to those subtasks, every activity entry
 * referencing them, every attachment (Firestore doc + Storage object) for
 * them, plus the block record itself + its consent map entry. Outbound
 * `blockedBy` edges from surviving subtasks pointing into the deleted set
 * are stripped so no row gets stuck waiting on a phantom blocker.
 *
 * Pre-2026-04-27 behaviour was rehome-to-ungrouped (subtasks survived with
 * `blockId: null`). Surfaced as a footgun — admins expected a delete to
 * actually delete the work; ungrouped subtasks pile up in the no-block
 * tail of a task and obscure intent. This route restores the cascade.
 *
 * Permission mirrors `/tasks/{id}/delete` (the only other cascade-delete in
 * the system): admin, committee creator on a committee-visibility task,
 * or personal creator on a personal task. Activity entries + comment
 * deletion bypass Firestore rules via Admin SDK — clients can't do this
 * themselves (`activity` is `update, delete: if false`; `comments` is
 * admin-only on delete).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const blockId = typeof payload.blockId === "string" ? payload.blockId : "";
  if (!blockId) {
    return NextResponse.json({ error: "blockId required" }, { status: 400 });
  }

  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const task = taskSnap.data() ?? {};

  const isCreator = viewer.uid === task.creatorUid;
  const canDelete =
    viewer.role === "admin" ||
    (viewer.role === "committee" &&
      task.visibility === "committee" &&
      isCreator) ||
    (task.source === "personal" && isCreator);
  if (!canDelete) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const blocks = Array.isArray(task.blocks) ? (task.blocks as unknown[]) : [];
  const blockEntry = blocks.find(
    (b) => b && typeof b === "object" && (b as { id?: unknown }).id === blockId,
  ) as { id?: string; name?: string } | undefined;
  if (!blockEntry) {
    return NextResponse.json({ error: "Block not found on task" }, { status: 404 });
  }
  const blockName = typeof blockEntry.name === "string" ? blockEntry.name : "";

  const subtasks = Array.isArray(task.subtasks) ? (task.subtasks as unknown[]) : [];
  const deletedIds = new Set<string>();
  for (const raw of subtasks) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (s.blockId === blockId && typeof s.id === "string") {
      deletedIds.add(s.id);
    }
  }

  // Build the surviving subtasks array. Drop any blockedBy refs that
  // pointed at a deleted subtask so the dependency graph stays consistent.
  const survivingSubtasks: unknown[] = [];
  for (const raw of subtasks) {
    if (!raw || typeof raw !== "object") {
      survivingSubtasks.push(raw);
      continue;
    }
    const s = raw as Record<string, unknown>;
    if (s.blockId === blockId) continue;
    const blockedBy = Array.isArray(s.blockedBy)
      ? (s.blockedBy as unknown[]).filter(
          (id): id is string => typeof id === "string" && !deletedIds.has(id),
        )
      : [];
    survivingSubtasks.push({ ...s, blockedBy });
  }

  const remainingBlocks = blocks
    .filter(
      (b) => b && typeof b === "object" && (b as { id?: unknown }).id !== blockId,
    )
    .map((b, i) => ({ ...(b as Record<string, unknown>), order: i }));

  const blockConsents =
    task.blockConsents && typeof task.blockConsents === "object"
      ? { ...(task.blockConsents as Record<string, unknown>) }
      : {};
  delete blockConsents[blockId];

  // Subcollection sweep — read each collection once, filter in memory by
  // subtaskId. Per-task volumes are small (max 50 subtasks ⇒ similar order
  // of comments/activity in practice), so an in-memory scan is cheaper
  // than chunked `in` queries (Firestore caps `in` at 30 values).
  const [commentsSnap, activitySnap, attachmentsSnap] = await Promise.all([
    taskRef.collection("comments").get(),
    taskRef.collection("activity").get(),
    taskRef.collection("attachments").get(),
  ]);

  const doomedComments = commentsSnap.docs.filter((d) => {
    const subtaskId = d.data().subtaskId;
    return typeof subtaskId === "string" && deletedIds.has(subtaskId);
  });
  const doomedActivity = activitySnap.docs.filter((d) => {
    const payload = d.data().payload as Record<string, unknown> | undefined;
    const subtaskId = payload?.subtaskId;
    return typeof subtaskId === "string" && deletedIds.has(subtaskId);
  });
  const doomedAttachments = attachmentsSnap.docs.filter((d) => {
    const subtaskId = d.data().subtaskId;
    return typeof subtaskId === "string" && deletedIds.has(subtaskId);
  });

  const storagePaths = doomedAttachments
    .map((d) => d.data().storagePath)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  // Decrement commentCount before the comment docs vanish so the parent
  // task's counter stays in sync (the field is the canonical "comments
  // remaining" count used by the board pill).
  const commentCountDelta = -doomedComments.length;

  // Recompute subtaskStats off the surviving rows so the badge / progress
  // bar updates immediately. Mirrors `computeSubtaskStats` semantics.
  let doneCount = 0;
  let totalCount = 0;
  for (const raw of survivingSubtasks) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    totalCount += 1;
    if (s.done === true) doneCount += 1;
  }

  // Two-phase write: parent doc patch first (so the UI reflects the
  // delete the moment it lands), then the subcollection cleanup. Doing
  // them in one batch is impossible — recursive subcollection delete uses
  // BulkWriter, which isn't compatible with the regular batch API.
  await taskRef.update({
    subtasks: survivingSubtasks,
    blocks: remainingBlocks,
    blockConsents,
    subtaskStats: { done: doneCount, total: totalCount },
    commentCount: FieldValue.increment(commentCountDelta),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Fire-and-forget the subcollection sweep through a BulkWriter so we
  // don't block the response on the long tail of small writes. Errors are
  // swallowed per-doc so a single permission blip can't strand the whole
  // sweep.
  const writer = db.bulkWriter();
  writer.onWriteError(() => true); // retry on transient failures
  for (const doc of doomedComments) writer.delete(doc.ref);
  for (const doc of doomedActivity) writer.delete(doc.ref);
  for (const doc of doomedAttachments) writer.delete(doc.ref);
  await writer.close();

  // Best-effort Storage cleanup — same posture as /tasks/[id]/delete.
  // After Firestore so a Storage failure doesn't strand a doc-still-
  // exists state.
  let storageDeleted = 0;
  let storageFailed = 0;
  const storage = getAdminStorage();
  if (storage && storagePaths.length > 0) {
    const bucket = storage.bucket();
    await Promise.all(
      storagePaths.map(async (path) => {
        try {
          await bucket.file(path).delete({ ignoreNotFound: true });
          storageDeleted += 1;
        } catch (err) {
          storageFailed += 1;
          console.warn(`[delete-block] storage delete failed for ${path}:`, err);
        }
      }),
    );
  }

  // Activity entry on the parent task — written via Admin SDK so it
  // bypasses the actorUid==auth.uid client-rule constraint while still
  // recording the actor for audit. Carries the deleted-ids list so a
  // future "restore" affordance has the receipts (no restore today —
  // just intentional posture).
  await taskRef.collection("activity").add({
    kind: "block_deleted",
    actorUid: viewer.uid,
    createdAt: FieldValue.serverTimestamp(),
    payload: {
      blockId,
      name: blockName,
      cascade: true,
      removedSubtaskIds: Array.from(deletedIds),
      removedSubtasks: deletedIds.size,
      removedComments: doomedComments.length,
      removedActivity: doomedActivity.length,
      removedAttachments: doomedAttachments.length,
    },
  });

  return NextResponse.json({
    ok: true,
    deleted: {
      subtasks: deletedIds.size,
      comments: doomedComments.length,
      activity: doomedActivity.length,
      attachments: doomedAttachments.length,
      storageDeleted,
      storageFailed,
    },
  });
}
