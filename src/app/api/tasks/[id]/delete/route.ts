import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { ownedStoragePaths } from "@/lib/firestore/taskAttachments";

/**
 * Cascade-delete a task: every comment, every activity entry, every
 * attachment (Firestore doc + Storage object), plus the parent task doc.
 *
 * Client-side rules block subcollection delete for non-admins (activity is
 * `allow update, delete: if false`; comments are admin-only). Doing this
 * server-side via Admin SDK is the only correct path — it bypasses rules
 * but we mirror the task-level delete authorization here:
 *   - admin (any task)
 *   - committee who created a committee-visibility task
 *   - creator of a personal task
 *
 * Storage objects for attachments are enumerated BEFORE the recursive doc
 * delete so we still have their `storagePath` values. Storage failures
 * (object missing, ACL blip) are logged but don't block the Firestore
 * cleanup — an orphaned Storage blob is strictly better than a phantom
 * Firestore doc (blob is invisible to the Console, phantom doc keeps
 * cluttering the tasks list).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await ctx.params;

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const task = taskSnap.data() ?? {};

  // Mirror firestore.rules `allow delete` on /tasks/{taskId}
  const isCreator = viewer.uid === task.creatorUid;
  const canDelete =
    viewer.role === "admin" ||
    (viewer.role === "committee" &&
      viewer.suRecognised &&
      task.visibility === "committee" &&
      isCreator) ||
    (task.source === "personal" && isCreator);
  if (!canDelete) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Pre-count + collect attachment storage paths for the cleanup pass.
  const [commentsSnap, activitySnap, attachmentsSnap] = await Promise.all([
    taskRef.collection("comments").count().get(),
    taskRef.collection("activity").count().get(),
    taskRef.collection("attachments").get(),
  ]);
  const storagePaths = ownedStoragePaths(
    taskId,
    attachmentsSnap.docs.map((d) => d.data().storagePath),
  );

  // BulkWriter-backed recursive delete handles comments + activity + attachments
  // + any nested collections in one call, paginated internally so batch-size
  // limits don't matter.
  await db.recursiveDelete(taskRef);

  // Best-effort Storage cleanup — after Firestore so a Storage failure doesn't
  // leave us in a "doc still exists, blobs gone" state.
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
          console.warn(`[delete] storage delete failed for ${path}:`, err);
        }
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      comments: commentsSnap.data().count,
      activity: activitySnap.data().count,
      attachments: attachmentsSnap.size,
      storageDeleted,
      storageFailed,
    },
  });
}
