import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type Payload = { subtaskId?: unknown };

/**
 * Cascade-delete a single subtask: removes the row from `task.subtasks`,
 * strips any `blockedBy` edges from surviving siblings that pointed at it,
 * and wipes every subcollection doc scoped to that subtask — comments
 * (`subtaskId === id`), activity (`payload.subtaskId === id`), attachments
 * (`subtaskId === id`, plus their Storage blobs).
 *
 * Pre-2026-04-29 `removeSubtask` only spliced the subtask out of the
 * parent doc's array. Subcomments + subtask-scoped activity + subtask
 * attachments became invisible orphans (no surface to render them once
 * the parent subtask was gone) that accumulated until the whole task was
 * deleted. This route closes the gap. The same pattern as
 * `/tasks/{id}/delete-block` — exists for the same reason: client rules
 * forbid subcollection delete (`activity` is `update, delete: if false`;
 * `comments` is admin-only on delete), and the cascade has to bypass via
 * Admin SDK.
 *
 * Permission band matches the existing in-app delete affordance —
 * `canEdit` (admin / committee on a committee-visibility task / any
 * completer or reviewer / personal creator). Tighter gates (admin-only,
 * matching task + block delete) would be a UX change beyond the cascade
 * fix; doing them here would muddy the diff.
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
  const subtaskId =
    typeof payload.subtaskId === "string" ? payload.subtaskId : "";
  if (!subtaskId) {
    return NextResponse.json({ error: "subtaskId required" }, { status: 400 });
  }

  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const task = taskSnap.data() ?? {};

  const completerUids = stringArray(task.completerUids);
  const reviewerUids = stringArray(task.reviewerUids);
  const isCreator = viewer.uid === task.creatorUid;
  const onTask =
    completerUids.includes(viewer.uid) || reviewerUids.includes(viewer.uid);
  const canDelete =
    viewer.role === "admin" ||
    (viewer.role === "committee" && task.visibility === "committee") ||
    onTask ||
    (task.source === "personal" && isCreator);
  if (!canDelete) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const subtasks = Array.isArray(task.subtasks) ? (task.subtasks as unknown[]) : [];
  const target = subtasks.find(
    (s) => s && typeof s === "object" && (s as { id?: unknown }).id === subtaskId,
  );
  if (!target) {
    return NextResponse.json({ error: "Subtask not found on task" }, { status: 404 });
  }

  // If the deleted subtask sat in an OPEN block, clear that block's
  // lock-in consent tally — the allocation picture just changed, so any
  // existing consensus is stale. Sealed blocks keep their record (it's
  // audit at that point); setup blocks have no consents yet. Mirrors
  // the legacy `clearConsentIfOpen` semantics so the existing deletion
  // UX doesn't regress.
  const targetBlockId =
    typeof (target as { blockId?: unknown }).blockId === "string"
      ? (target as { blockId: string }).blockId
      : null;
  const blocks = Array.isArray(task.blocks) ? (task.blocks as unknown[]) : [];
  const targetBlock = blocks.find(
    (b) =>
      b &&
      typeof b === "object" &&
      (b as { id?: unknown }).id === targetBlockId,
  );
  const blockIsOpen =
    targetBlock &&
    typeof targetBlock === "object" &&
    (targetBlock as { sealState?: unknown }).sealState === "open";
  let nextBlockConsents:
    | Record<string, { consentingCompleterUids: string[] }>
    | null = null;
  if (
    blockIsOpen &&
    targetBlockId &&
    task.blockConsents &&
    typeof task.blockConsents === "object"
  ) {
    const existing = (task.blockConsents as Record<string, unknown>)[targetBlockId];
    const list = existing && typeof existing === "object"
      ? ((existing as Record<string, unknown>).consentingCompleterUids ?? null)
      : null;
    if (Array.isArray(list) && list.length > 0) {
      nextBlockConsents = { ...(task.blockConsents as Record<string, { consentingCompleterUids: string[] }>) };
      nextBlockConsents[targetBlockId] = { consentingCompleterUids: [] };
    }
  }

  // Build the surviving subtasks array. Drop any `blockedBy` ref pointing at
  // the deleted subtask so the dependency graph stays consistent — same
  // posture as the legacy in-array `removeSubtask` mutation, just done
  // server-side now.
  const survivingSubtasks: unknown[] = [];
  for (const raw of subtasks) {
    if (!raw || typeof raw !== "object") {
      survivingSubtasks.push(raw);
      continue;
    }
    const s = raw as Record<string, unknown>;
    if (s.id === subtaskId) continue;
    const blockedBy = Array.isArray(s.blockedBy)
      ? (s.blockedBy as unknown[]).filter(
          (id): id is string => typeof id === "string" && id !== subtaskId,
        )
      : [];
    survivingSubtasks.push({ ...s, blockedBy });
  }

  // Subcollection sweep — read once, filter in memory by subtaskId.
  // Per-task volumes are small enough that the in-memory filter is
  // cheaper than chunked `in` queries.
  const [commentsSnap, activitySnap, attachmentsSnap] = await Promise.all([
    taskRef.collection("comments").get(),
    taskRef.collection("activity").get(),
    taskRef.collection("attachments").get(),
  ]);

  const doomedComments = commentsSnap.docs.filter((d) => {
    const sid = d.data().subtaskId;
    return typeof sid === "string" && sid === subtaskId;
  });
  const doomedActivity = activitySnap.docs.filter((d) => {
    const payload = d.data().payload as Record<string, unknown> | undefined;
    return (
      typeof payload?.subtaskId === "string" && payload.subtaskId === subtaskId
    );
  });
  const doomedAttachments = attachmentsSnap.docs.filter((d) => {
    const sid = d.data().subtaskId;
    return typeof sid === "string" && sid === subtaskId;
  });

  const storagePaths = doomedAttachments
    .map((d) => d.data().storagePath)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  // Recompute subtaskStats off survivors — keeps the parent's
  // `done/total` pill in sync without a snapshot bounce.
  let doneCount = 0;
  let totalCount = 0;
  for (const raw of survivingSubtasks) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    totalCount += 1;
    if (s.done === true) doneCount += 1;
  }

  const commentCountDelta = -doomedComments.length;

  // Two-phase write: parent doc patch first so the UI reflects the
  // delete the moment it lands, then BulkWriter sweeps subcollections.
  // Mirrors the delete-block route's posture exactly.
  const parentPatch: Record<string, unknown> = {
    subtasks: survivingSubtasks,
    subtaskStats: { done: doneCount, total: totalCount },
    commentCount: FieldValue.increment(commentCountDelta),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (nextBlockConsents !== null) {
    parentPatch.blockConsents = nextBlockConsents;
  }
  await taskRef.update(parentPatch);

  const writer = db.bulkWriter();
  writer.onWriteError(() => true);
  for (const doc of doomedComments) writer.delete(doc.ref);
  for (const doc of doomedActivity) writer.delete(doc.ref);
  for (const doc of doomedAttachments) writer.delete(doc.ref);
  await writer.close();

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
          console.warn(`[delete-subtask] storage delete failed for ${path}:`, err);
        }
      }),
    );
  }

  // Audit entry — written via Admin SDK so it bypasses the actorUid==
  // auth.uid client rule. Carries enough payload that a future restore
  // affordance has the receipts (no restore today; just intentional
  // posture). Not scoped via `payload.subtaskId` so the subtask modal's
  // activity feed (which filters by subtaskId) doesn't try to render
  // the entry against a deleted subtask.
  const targetTitle =
    typeof (target as { title?: unknown }).title === "string"
      ? (target as { title: string }).title
      : "Untitled";
  await taskRef.collection("activity").add({
    kind: "subtask_deleted",
    actorUid: viewer.uid,
    createdAt: FieldValue.serverTimestamp(),
    payload: {
      removedSubtaskId: subtaskId,
      title: targetTitle,
      cascade: true,
      removedComments: doomedComments.length,
      removedActivity: doomedActivity.length,
      removedAttachments: doomedAttachments.length,
    },
  });

  return NextResponse.json({
    ok: true,
    deleted: {
      comments: doomedComments.length,
      activity: doomedActivity.length,
      attachments: doomedAttachments.length,
      storageDeleted,
      storageFailed,
    },
  });
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((u): u is string => typeof u === "string");
}
