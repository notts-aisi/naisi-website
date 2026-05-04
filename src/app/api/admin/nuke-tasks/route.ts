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

  // listDocuments() (NOT .get()) returns refs for every document path
  // under `tasks/`, including "ghost parents" — paths that have
  // surviving subcollection docs but no actual parent doc. Those ghosts
  // are what shows up italicised in the Firebase Console after a
  // pre-cascade delete (or a direct Console delete) and were the whole
  // gap in the first cut of this route. Iterating these refs catches
  // every subcollection stuck under deleted-or-never-existed tasks.
  const taskRefs = await db.collection("tasks").listDocuments();
  const taskCount = taskRefs.length;

  // Per-ref subcollection enumeration: count comments + activity, pull
  // attachment storagePaths so we can clean Storage afterwards. Doing
  // this BEFORE the recursive delete because once the doc tree is
  // gone, we can't reconstruct the paths.
  const storagePaths: string[] = [];
  let totalComments = 0;
  let totalActivity = 0;
  let totalAttachments = 0;

  for (const ref of taskRefs) {
    const [commentsSnap, activitySnap, attachmentsSnap] = await Promise.all([
      ref.collection("comments").count().get(),
      ref.collection("activity").count().get(),
      ref.collection("attachments").get(),
    ]);
    totalComments += commentsSnap.data().count;
    totalActivity += activitySnap.data().count;
    totalAttachments += attachmentsSnap.size;
    for (const a of attachmentsSnap.docs) {
      const path = a.data().storagePath;
      if (typeof path === "string" && path.length > 0) storagePaths.push(path);
    }
  }

  // Single recursive-delete on the whole `tasks/` collection. The
  // collection-ref form of `recursiveDelete` walks listDocuments()
  // internally — so it catches ghost parents AND every nested
  // subcollection in one pass. Cheaper + more thorough than iterating
  // the ref list ourselves; the iteration above is just for the
  // pre-delete bookkeeping (Storage paths + report counts).
  await db.recursiveDelete(db.collection("tasks"));

  // Belt-and-braces Storage cleanup. Two passes:
  //
  //   1. Delete each path from the `storagePath` field on attachment
  //      docs (matches what `/api/tasks/{id}/delete` does).
  //   2. Prefix-delete every blob under the `tasks/` Storage prefix.
  //      Catches orphaned blobs whose attachment doc was already gone
  //      before this route fired (legacy uploads from before the
  //      cascade work). Safe because `tasks/` is exclusively task-
  //      attachment territory in this project — newsletter uploads
  //      live under a different prefix.
  let storageDeleted = 0;
  let storageFailed = 0;
  let prefixSwept = 0;
  const storage = getAdminStorage();
  if (storage) {
    const bucket = storage.bucket();
    if (storagePaths.length > 0) {
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
    // Prefix sweep — `getFiles({ prefix: "tasks/" })` returns every
    // blob whose name starts with `tasks/`, regardless of whether it's
    // referenced by a Firestore doc. Deletes are best-effort.
    try {
      const [files] = await bucket.getFiles({ prefix: "tasks/" });
      await Promise.all(
        files.map(async (file) => {
          try {
            await file.delete({ ignoreNotFound: true });
            prefixSwept += 1;
          } catch (err) {
            console.warn(`[nuke-tasks] prefix sweep failed for ${file.name}:`, err);
          }
        }),
      );
    } catch (err) {
      console.warn("[nuke-tasks] prefix listing failed; orphan blobs may remain:", err);
    }
  }

  // Server-side breadcrumb so the deploy logs show who wiped what,
  // when, in which project. The activity-log entries that would
  // normally record this all live UNDER tasks/ — so they got nuked
  // along with the tasks themselves; logging here is the only
  // surviving trace.
  console.warn(
    `[nuke-tasks] admin=${viewer.uid} wiped ${taskCount} task paths (incl. ghost parents), ${totalComments} comments, ${totalActivity} activity entries, ${totalAttachments} attachments (${storageDeleted} referenced blobs deleted, ${storageFailed} failed; ${prefixSwept} additional blobs swept from tasks/ prefix)`,
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
      prefixSwept,
    },
  });
}
