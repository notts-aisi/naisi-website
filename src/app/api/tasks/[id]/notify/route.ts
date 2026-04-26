import { NextResponse } from "next/server";
import TaskCommentEmail from "@/emails/TaskCommentEmail";
import { sendEmail } from "@/lib/email/send";
import { getAdminDb } from "@/lib/firebase/admin";
import { isTaskEmailEnabled } from "@/lib/firestore/taskEmailConfig";
import { getCurrentUser } from "@/lib/firebase/session";

type NotifyPayload = {
  commentId?: unknown;
  forceEmailCompleters?: unknown;
  forceEmailReviewers?: unknown;
  /** UIDs that were already mentioned in the previous version of this comment.
   *  Used on edit to avoid re-emailing people who were pinged on the original
   *  post. Omit / pass [] for a fresh create. */
  priorMentions?: unknown;
  /** Optional subtask scope for the notify event. When the comment was
   *  posted as a subcomment (Phase 3 subcomment thread), the email
   *  subject + body include the subtask title so recipients land on the
   *  right context. Omit / null on task-level comments. */
  subtaskId?: unknown;
};

type Reason = "mention" | "completer" | "reviewer";

const PREVIEW_MAX = 280;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * Read the display name/email for a set of uids via Admin SDK. Missing users
 * are silently dropped — the caller sees a smaller recipient list rather than
 * a 500.
 */
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

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await ctx.params;

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Admin-toggleable kill switch (config/taskEmails). Dev affordance — the
  // comment itself still posts in-app, the email is what's suppressed.
  if (!(await isTaskEmailEnabled(db))) {
    return NextResponse.json(
      { ok: true, skipped: "task-emails-disabled", recipients: 0 },
      { status: 200 },
    );
  }

  let payload: NotifyPayload;
  try {
    payload = (await req.json()) as NotifyPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const commentId = typeof payload.commentId === "string" ? payload.commentId : "";
  if (!commentId) {
    return NextResponse.json({ error: "commentId required" }, { status: 400 });
  }
  const forceEmailCompleters = payload.forceEmailCompleters === true;
  const forceEmailReviewers = payload.forceEmailReviewers === true;
  const subtaskId =
    typeof payload.subtaskId === "string" && payload.subtaskId
      ? payload.subtaskId
      : null;
  const priorMentionSet = new Set<string>(
    Array.isArray(payload.priorMentions)
      ? (payload.priorMentions as unknown[]).filter((u): u is string => typeof u === "string")
      : [],
  );

  const taskSnap = await db.collection("tasks").doc(taskId).get();
  if (!taskSnap.exists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const task = taskSnap.data() ?? {};

  // Authorisation: anyone who can access the task can trigger a notify (they
  // just wrote a comment, so they can read it). Admin + committee-on-committee
  // + completer + reviewer.
  const viewerRole = viewer.role;
  const viewerIsOnTask =
    Array.isArray(task.completerUids) && (task.completerUids as unknown[]).includes(viewer.uid) ||
    Array.isArray(task.reviewerUids) && (task.reviewerUids as unknown[]).includes(viewer.uid);
  const canAccess =
    viewerRole === "admin" ||
    (task.visibility === "committee" && viewerRole === "committee") ||
    viewerIsOnTask;
  if (!canAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const commentSnap = await db
    .collection("tasks")
    .doc(taskId)
    .collection("comments")
    .doc(commentId)
    .get();
  if (!commentSnap.exists) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }
  const comment = commentSnap.data() ?? {};
  const authorUid = typeof comment.authorUid === "string" ? comment.authorUid : "";
  const bodyMarkdown = typeof comment.bodyMarkdown === "string" ? comment.bodyMarkdown : "";
  const mentions: string[] = Array.isArray(comment.mentions)
    ? (comment.mentions as unknown[]).filter((u): u is string => typeof u === "string")
    : [];

  // Build the recipient map with reasons. Mention takes priority if a user is
  // in multiple sets (mention email is the most direct). Exclude mentions that
  // were already present in the previous revision of the comment so edits
  // only ping the *newly* added names.
  const reasonByUid = new Map<string, Reason>();
  for (const uid of mentions) {
    if (priorMentionSet.has(uid)) continue;
    reasonByUid.set(uid, "mention");
  }
  if (forceEmailCompleters && Array.isArray(task.completerUids)) {
    for (const uid of task.completerUids as unknown[]) {
      if (typeof uid === "string" && !reasonByUid.has(uid)) {
        reasonByUid.set(uid, "completer");
      }
    }
  }
  if (forceEmailReviewers && Array.isArray(task.reviewerUids)) {
    for (const uid of task.reviewerUids as unknown[]) {
      if (typeof uid === "string" && !reasonByUid.has(uid)) {
        reasonByUid.set(uid, "reviewer");
      }
    }
  }
  // Don't email the author about their own comment.
  reasonByUid.delete(authorUid);

  if (reasonByUid.size === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: "no recipients" });
  }

  const recipientUids = Array.from(reasonByUid.keys());
  const users = await resolveUsers(db, recipientUids);
  const authorInfo = (await resolveUsers(db, [authorUid])).get(authorUid);
  const authorName = authorInfo?.displayName ?? "Someone";

  const taskTitle = typeof task.title === "string" ? task.title : "a task";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";
  const taskLink = `${appUrl}/committee/tasks?task=${encodeURIComponent(taskId)}`;

  // Resolve the subtask title for subject-line context. Subcomment pings
  // read better as "X commented on subtask Y" than "X commented on Z".
  // Drops back to task-level wording silently if the subtask can't be
  // found (admin deleted it between comment + notify).
  let subtaskTitle: string | null = null;
  if (subtaskId && Array.isArray(task.subtasks)) {
    for (const raw of task.subtasks as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (s.id === subtaskId && typeof s.title === "string") {
        subtaskTitle = s.title;
        break;
      }
    }
  }
  // Mention tokens render poorly in plain text — strip them down to @Name for the preview.
  const commentPreview = truncate(
    bodyMarkdown.replace(/@\[([^\]]+)\]\(uid:[^)]+\)/g, "@$1"),
    PREVIEW_MAX,
  );

  let sent = 0;
  let failed = 0;
  for (const [uid, reason] of reasonByUid.entries()) {
    const user = users.get(uid);
    if (!user) {
      failed += 1;
      continue;
    }
    try {
      // Subtask pings tag the subject so the recipient lands on the right
      // context; the body still names the parent task so the existing
      // template renders cleanly without bespoke subtask-aware copy.
      const subject =
        reason === "mention"
          ? subtaskTitle
            ? `${authorName} mentioned you on subtask "${subtaskTitle}"`
            : `${authorName} mentioned you in "${taskTitle}"`
          : subtaskTitle
            ? `${authorName} commented on subtask "${subtaskTitle}" — ${taskTitle}`
            : `${authorName} commented on "${taskTitle}"`;
      await sendEmail({
        to: user.email,
        subject,
        fromName: "NAISI Tasks",
        kind: "task",
        actorUid: authorUid || viewer.uid,
        referenceId: taskId,
        react: TaskCommentEmail({
          recipientName: user.displayName || "there",
          authorName,
          taskTitle,
          commentPreview,
          taskLink,
          reason,
        }),
      });
      sent += 1;
    } catch (err) {
      console.error(`[notify] send to ${user.email} failed`, err);
      failed += 1;
    }
  }

  return NextResponse.json({ ok: true, sent, failed });
}
