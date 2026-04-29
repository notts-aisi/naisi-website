/**
 * TEMPORARY admin tool — wipes every task in this Firestore project, plus
 * all subcollections (comments / activity / attachments) and the
 * corresponding Storage blobs. Designed to be used once per environment
 * (dev + prod) to reset task-manager data after the dev push that
 * accumulated test rows during the redesign arc, then DELETED in a
 * follow-up PR. Lives under `/api/admin/...` (not `/api/tasks/...`)
 * because it isn't a per-task op and shouldn't share permission gates
 * with the in-app delete.
 *
 * Targets whichever Firestore project the App Hosting backend is wired
 * to — Admin SDK reads project credentials from the runtime env, so
 * pressing the button on the dev backend wipes dev, on prod it wipes
 * prod. There's no cross-environment leak.
 *
 * Belt-and-braces gate: admin role + `confirm: "DELETE ALL TASKS"`
 * literal string in the request body. The literal-string requirement
 * exists so a curl reflex or copy-paste accident can't fire the route
 * accidentally; the client UI types it for the user after a strong
 * confirm modal.
 */
import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

const REQUIRED_CONFIRM = "DELETE ALL TASKS";

type Payload = { confirm?: unknown };

export async function POST(req: Request) {
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer || viewer.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (payload.confirm !== REQUIRED_CONFIRM) {
    return NextResponse.json(
      {
        error: `Confirmation phrase mismatch. Send { confirm: "${REQUIRED_CONFIRM}" } to fire.`,
      },
      { status: 400 },
    );
  }

  const tasksSnap = await db.collection("tasks").get();
  const taskCount = tasksSnap.size;

  // Enumerate every attachment Storage path BEFORE the recursive doc
  // delete — once the parent task doc is gone we lose the
  // `storagePath` strings we'd need to clean Storage. Same posture as
  // the per-task `/delete` route.
  const storagePaths: string[] = [];
  let totalComments = 0;
  let totalActivity = 0;
  let totalAttachments = 0;

  for (const taskDoc of tasksSnap.docs) {
    const [commentsSnap, activitySnap, attachmentsSnap] = await Promise.all([
      taskDoc.ref.collection("comments").count().get(),
      taskDoc.ref.collection("activity").count().get(),
      taskDoc.ref.collection("attachments").get(),
    ]);
    totalComments += commentsSnap.data().count;
    totalActivity += activitySnap.data().count;
    totalAttachments += attachmentsSnap.size;
    for (const a of attachmentsSnap.docs) {
      const path = a.data().storagePath;
      if (typeof path === "string" && path.length > 0) storagePaths.push(path);
    }
  }

  // Recursive delete each task doc — same primitive `/api/tasks/{id}/
  // delete` uses, just iterated. Done sequentially so a rate-limit
  // burst on Firestore doesn't fire all at once on a project with many
  // tasks. Per-task volumes are small; latency from sequencing is
  // acceptable for a fire-once tool.
  for (const taskDoc of tasksSnap.docs) {
    await db.recursiveDelete(taskDoc.ref);
  }

  // Best-effort Storage cleanup. Same posture as the existing delete
  // routes — orphaned blobs are strictly better than phantom Firestore
  // docs (blobs are invisible to the Console, phantom docs clutter the
  // task list).
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
          console.warn(`[nuke-tasks] storage delete failed for ${path}:`, err);
        }
      }),
    );
  }

  // Server-side breadcrumb so the deploy logs show who wiped what,
  // when, in which project. The activity-log entries that would
  // normally record this all live UNDER tasks/ — so they got nuked
  // along with the tasks themselves; logging here is the only
  // surviving trace.
  console.warn(
    `[nuke-tasks] admin=${viewer.uid} wiped ${taskCount} tasks, ${totalComments} comments, ${totalActivity} activity entries, ${totalAttachments} attachments (${storageDeleted} Storage blobs deleted, ${storageFailed} failed)`,
  );

  return NextResponse.json({
    ok: true,
    deleted: {
      tasks: taskCount,
      comments: totalComments,
      activity: totalActivity,
      attachments: totalAttachments,
      storageDeleted,
      storageFailed,
    },
  });
}
