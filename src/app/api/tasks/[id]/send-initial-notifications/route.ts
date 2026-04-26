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

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((u): u is string => typeof u === "string");
}

async function stampInitialNotifyAt(
  db: FirebaseFirestore.Firestore,
  taskId: string,
  actorUid: string,
  memberCount: number,
) {
  const taskRef = db.collection("tasks").doc(taskId);
  await taskRef.update({
    initialNotifyAt: FieldValue.serverTimestamp(),
    pendingNotifyUids: [],
    updatedAt: FieldValue.serverTimestamp(),
  });
  await taskRef.collection("activity").add({
    kind: "initial_notifications_sent",
    actorUid,
    createdAt: FieldValue.serverTimestamp(),
    payload: { recipients: memberCount },
  });
}

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

  // Permission check happens before the kill switch — a non-admin
  // shouldn't be able to advance the task out of setup even when the dev
  // kill switch is silencing real sends.
  const completerUids = stringArray(task.completerUids);
  const reviewerUids = stringArray(task.reviewerUids);
  const isCreator = task.creatorUid === viewer.uid;
  const isPersonalCreator = task.source === "personal" && isCreator;
  if (viewer.role !== "admin" && !isPersonalCreator) {
    return NextResponse.json(
      {
        error:
          "Only an admin (or the creator of a personal task) can send initial notifications.",
      },
      { status: 403 },
    );
  }
  if (task.initialNotifyAt) {
    return NextResponse.json(
      { error: "Initial notifications already sent for this task." },
      { status: 400 },
    );
  }
  const recipientList = Array.from(new Set([...completerUids, ...reviewerUids]));
  if (recipientList.length === 0) {
    return NextResponse.json(
      { error: "Add at least one member before sending initial notifications." },
      { status: 400 },
    );
  }

  // Kill switch: still flip initialNotifyAt so the UI advances out of setup
  // (the affordance is for testing the workflow, not blocking it).
  if (!(await isTaskEmailEnabled(db))) {
    await stampInitialNotifyAt(db, taskId, viewer.uid, recipientList.length);
    return NextResponse.json(
      { ok: true, skipped: "task-emails-disabled", recipients: recipientList.length },
      { status: 200 },
    );
  }

  const users = await resolveTaskUsers(db, recipientList);
  const taskTitle = typeof task.title === "string" ? task.title : "a task";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";
  const taskLink = `${appUrl}/committee/tasks?task=${encodeURIComponent(taskId)}`;

  let sent = 0;
  let failed = 0;
  for (const uid of recipientList) {
    const user = users.get(uid);
    if (!user) {
      failed += 1;
      continue;
    }
    const payload = buildMembershipEmailPayload({
      recipientUid: uid,
      task,
      users,
    });
    try {
      await sendEmail({
        to: user.email,
        subject: `You've been added to "${taskTitle}"`,
        fromName: "NAISI Tasks",
        kind: "task",
        actorUid: viewer.uid,
        referenceId: taskId,
        react: TaskMembershipEmail({
          recipientName: user.displayName || "there",
          taskTitle,
          taskLink,
          preassignments: payload.preassignments,
          otherCompleterNames: payload.otherCompleterNames,
        }),
      });
      sent += 1;
    } catch (err) {
      console.error(`[send-initial-notifications] send to ${user.email} failed`, err);
      failed += 1;
    }
  }

  await stampInitialNotifyAt(db, taskId, viewer.uid, recipientList.length);
  return NextResponse.json({ ok: true, sent, failed });
}
