import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import TaskMembershipEmail from "@/emails/TaskMembershipEmail";
import { sendEmail } from "@/lib/email/send";
import {
  buildMembershipEmailPayload,
  resolveTaskUsers,
} from "@/lib/email/taskMembership";
import { getAdminDb } from "@/lib/firebase/admin";
import { isTaskEmailEnabled } from "@/lib/firestore/taskEmailConfig";
import { getCurrentUser } from "@/lib/firebase/session";

type Payload = { uid?: unknown };

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((u): u is string => typeof u === "string");
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
  const target = typeof payload.uid === "string" ? payload.uid : "";
  if (!target) {
    return NextResponse.json({ error: "uid required" }, { status: 400 });
  }

  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const task = taskSnap.data() ?? {};

  // Permission: same as the batch route — admin or personal-task creator.
  const isCreator = task.creatorUid === viewer.uid;
  const isPersonalCreator = task.source === "personal" && isCreator;
  if (viewer.role !== "admin" && !isPersonalCreator) {
    return NextResponse.json(
      { error: "Only an admin (or the creator of a personal task) can notify a member." },
      { status: 403 },
    );
  }

  // Phase guard: per-uid Notify only makes sense AFTER initial notifications.
  if (!task.initialNotifyAt) {
    return NextResponse.json(
      {
        error:
          "Initial notifications haven't been sent yet — use 'Send initial notifications' first.",
      },
      { status: 400 },
    );
  }

  const completerUids = stringArray(task.completerUids);
  const reviewerUids = stringArray(task.reviewerUids);
  const onTask = completerUids.includes(target) || reviewerUids.includes(target);
  if (!onTask) {
    return NextResponse.json(
      { error: "User isn't on this task." },
      { status: 400 },
    );
  }

  const pendingNotifyUids = stringArray(task.pendingNotifyUids);
  if (!pendingNotifyUids.includes(target)) {
    return NextResponse.json(
      { error: "User is not in the pending-notification list." },
      { status: 400 },
    );
  }

  // Whether or not the kill switch suppresses the send, we always clear
  // the uid from pendingNotifyUids — pressing Notify is the user's
  // declaration that the per-uid queue has been actioned.
  const actorUid = viewer.uid;
  async function clearPending() {
    await taskRef.update({
      pendingNotifyUids: FieldValue.arrayRemove(target),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await taskRef.collection("activity").add({
      kind: "member_notified",
      actorUid,
      createdAt: FieldValue.serverTimestamp(),
      payload: { uid: target },
    });
  }

  if (!(await isTaskEmailEnabled(db))) {
    await clearPending();
    return NextResponse.json(
      { ok: true, skipped: "task-emails-disabled" },
      { status: 200 },
    );
  }

  const users = await resolveTaskUsers(db, [target, ...completerUids, ...reviewerUids]);
  const recipient = users.get(target);
  if (!recipient) {
    // Even when the user doc is missing, drop them from pendingNotifyUids
    // so a stale entry doesn't keep showing the inline button forever.
    await clearPending();
    return NextResponse.json(
      { ok: false, error: "Recipient user record missing." },
      { status: 200 },
    );
  }

  const taskTitle = typeof task.title === "string" ? task.title : "a task";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";
  const taskLink = `${appUrl}/committee/tasks?task=${encodeURIComponent(taskId)}`;
  const slice = buildMembershipEmailPayload({
    recipientUid: target,
    task,
    users,
  });

  let sent = 0;
  try {
    await sendEmail({
      to: recipient.email,
      subject: `You've been added to "${taskTitle}"`,
      fromName: "NAISI Tasks",
      kind: "task",
      actorUid: viewer.uid,
      referenceId: taskId,
      react: TaskMembershipEmail({
        recipientName: recipient.displayName || "there",
        taskTitle,
        taskLink,
        preassignments: slice.preassignments,
        otherCompleterNames: slice.otherCompleterNames,
      }),
    });
    sent = 1;
  } catch (err) {
    console.error(`[notify-member] send to ${recipient.email} failed`, err);
  }
  await clearPending();
  return NextResponse.json({ ok: true, sent });
}
