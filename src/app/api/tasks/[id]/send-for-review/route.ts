import { NextResponse } from "next/server";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import TaskReviewRequestEmail from "@/emails/TaskReviewRequestEmail";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type Payload = {
  commentId?: unknown;
  subtaskId?: unknown;
};

const PREVIEW_MAX = 280;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function resolveUsers(
  db: FirebaseFirestore.Firestore,
  uids: string[],
): Promise<Map<string, { email: string; displayName: string }>> {
  const out = new Map<string, { email: string; displayName: string }>();
  if (uids.length === 0) return out;
  const refs = uids.map((uid) => db.collection("users").doc(uid));
  const snaps = await db.getAll(...refs);
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const data = snap.data() ?? {};
    const email = typeof data.email === "string" ? data.email : "";
    const displayName =
      typeof data.displayName === "string" && data.displayName
        ? data.displayName
        : email.split("@")[0] || "there";
    if (email) out.set(snap.id, { email, displayName });
  }
  return out;
}

function findSubtask(
  task: DocumentData,
  subtaskId: string | null,
): { id: string; title: string; reviewerUids: string[] } | null {
  if (!subtaskId || !Array.isArray(task.subtasks)) return null;
  for (const raw of task.subtasks as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (s.id === subtaskId) {
      const reviewerUids = Array.isArray(s.reviewerUids)
        ? (s.reviewerUids as unknown[]).filter((u): u is string => typeof u === "string")
        : [];
      return {
        id: subtaskId,
        title: typeof s.title === "string" ? s.title : "",
        reviewerUids,
      };
    }
  }
  return null;
}

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
  const commentId =
    typeof payload.commentId === "string" && payload.commentId ? payload.commentId : null;
  const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : null;

  const taskSnap = await db.collection("tasks").doc(taskId).get();
  if (!taskSnap.exists) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  const task = taskSnap.data() ?? {};

  const viewerRole = viewer.role;
  const viewerIsOnTask =
    (Array.isArray(task.completerUids) &&
      (task.completerUids as unknown[]).includes(viewer.uid)) ||
    (Array.isArray(task.reviewerUids) &&
      (task.reviewerUids as unknown[]).includes(viewer.uid));
  const canAccess =
    viewerRole === "admin" ||
    (task.visibility === "committee" && viewerRole === "committee") ||
    viewerIsOnTask;
  if (!canAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Pick reviewer list: per-subtask first, else task-level.
  const subtaskInfo = findSubtask(task, subtaskId);
  let reviewerUids: string[];
  let subtaskTitle: string | null = null;
  if (subtaskInfo && subtaskInfo.reviewerUids.length > 0) {
    reviewerUids = subtaskInfo.reviewerUids;
    subtaskTitle = subtaskInfo.title;
  } else {
    reviewerUids = Array.isArray(task.reviewerUids)
      ? (task.reviewerUids as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
  }

  // Don't email the requester if they're a reviewer themselves.
  reviewerUids = reviewerUids.filter((u) => u !== viewer.uid);
  if (reviewerUids.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No reviewer to notify." },
      { status: 400 },
    );
  }

  const [reviewers, requesterInfo] = await Promise.all([
    resolveUsers(db, reviewerUids),
    resolveUsers(db, [viewer.uid]),
  ]);
  const requesterName = requesterInfo.get(viewer.uid)?.displayName ?? "Someone";

  // Comment preview (optional — only if commentId provided).
  let commentPreview: string | null = null;
  if (commentId) {
    const commentSnap = await db
      .collection("tasks")
      .doc(taskId)
      .collection("comments")
      .doc(commentId)
      .get();
    if (commentSnap.exists) {
      const body = (commentSnap.data()?.bodyMarkdown as string | undefined) ?? "";
      commentPreview = truncate(
        body.replace(/@\[([^\]]+)\]\(uid:[^)]+\)/g, "@$1"),
        PREVIEW_MAX,
      );
    }
  }

  const taskTitle = typeof task.title === "string" ? task.title : "a task";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";
  const taskLink = `${appUrl}/committee/tasks?task=${encodeURIComponent(taskId)}`;

  let sent = 0;
  let failed = 0;
  for (const uid of reviewerUids) {
    const user = reviewers.get(uid);
    if (!user) {
      failed += 1;
      continue;
    }
    try {
      await sendEmail({
        to: user.email,
        subject: subtaskTitle
          ? `Review requested: ${subtaskTitle} — ${taskTitle}`
          : `Review requested: ${taskTitle}`,
        fromName: "NAISI Tasks",
        react: TaskReviewRequestEmail({
          recipientName: user.displayName || "there",
          requesterName,
          taskTitle,
          subtaskTitle,
          commentPreview,
          taskLink,
        }),
      });
      sent += 1;
    } catch (err) {
      console.error(`[send-for-review] send to ${user.email} failed`, err);
      failed += 1;
    }
  }

  // Append `sent_for_review` activity via Admin SDK (rules would require
  // actorUid==auth.uid on the client, but Admin SDK bypasses rules).
  await db
    .collection("tasks")
    .doc(taskId)
    .collection("activity")
    .add({
      kind: "sent_for_review",
      actorUid: viewer.uid,
      createdAt: FieldValue.serverTimestamp(),
      payload: {
        subtaskId: subtaskTitle ? subtaskId : null,
        reviewerUids,
        commentId,
      },
    });

  return NextResponse.json({ ok: true, sent, failed });
}
