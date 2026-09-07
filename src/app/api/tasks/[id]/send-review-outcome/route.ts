import { NextResponse } from "next/server";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import TaskReviewOutcomeEmail, {
  type ReviewOutcomeSubtask,
} from "@/emails/TaskReviewOutcomeEmail";
import { wantsEmailForProfile } from "@/lib/email/preferences";
import { sendEmail } from "@/lib/email/send";
import type { ResolvedUser } from "@/lib/email/taskMembership";
import { getAdminDb } from "@/lib/firebase/admin";
import { isTaskEmailEnabled } from "@/lib/firestore/taskEmailConfig";
import { getCurrentUser } from "@/lib/firebase/session";
import { mirrorTaskEmailToPush } from "@/lib/push/taskNotifications";

type Payload = { blockId?: unknown };

const NOTE_MAX = 280;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function resolveUsers(
  db: FirebaseFirestore.Firestore,
  uids: string[],
): Promise<Map<string, ResolvedUser>> {
  const out = new Map<string, ResolvedUser>();
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
    if (email) out.set(snap.id, { email, displayName, profile: data.profile });
  }
  return out;
}

type SubtaskShape = {
  id: string;
  title: string;
  blockId: string | null;
  done: boolean;
  roleHint: "reviewer" | "completer" | null;
  reviewerUids: string[];
  approvedByReviewerUids: string[];
  questionedByReviewerUids: string[];
  rejectedByReviewerUids: string[];
};

function asSubtaskShape(raw: unknown): SubtaskShape | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === "string" ? s.id : null;
  const title = typeof s.title === "string" ? s.title : null;
  if (!id || !title) return null;
  const stringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? (v as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
  return {
    id,
    title,
    blockId: typeof s.blockId === "string" ? s.blockId : null,
    done: Boolean(s.done),
    roleHint:
      s.roleHint === "reviewer" || s.roleHint === "completer"
        ? s.roleHint
        : null,
    reviewerUids: stringArray(s.reviewerUids),
    approvedByReviewerUids: stringArray(s.approvedByReviewerUids),
    questionedByReviewerUids: stringArray(s.questionedByReviewerUids),
    rejectedByReviewerUids: stringArray(s.rejectedByReviewerUids),
  };
}

type BlockShape = {
  id: string;
  name: string;
  sealState: "setup" | "open" | "sealed";
  reviewMode: "review" | "skip-review";
  reviewPassSentAt: Date | null;
  sealedAt: Date | null;
};

function asBlockShape(raw: unknown): BlockShape | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : null;
  const name = typeof b.name === "string" ? b.name : null;
  if (!id || !name) return null;
  const tsToDate = (v: unknown): Date | null => {
    const obj = v as { toDate?: () => Date } | null | undefined;
    return obj && typeof obj.toDate === "function" ? obj.toDate() : null;
  };
  return {
    id,
    name,
    sealState:
      b.sealState === "sealed"
        ? "sealed"
        : b.sealState === "setup"
          ? "setup"
          : "open",
    reviewMode: b.reviewMode === "skip-review" ? "skip-review" : "review",
    reviewPassSentAt: tsToDate(b.reviewPassSentAt),
    sealedAt: tsToDate(b.sealedAt),
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await ctx.params;
  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const viewer = await getCurrentUser();
  if (!viewer) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  if (!(await isTaskEmailEnabled(db))) {
    return NextResponse.json(
      { ok: true, skipped: "task-emails-disabled", recipients: 0 },
      { status: 200 },
    );
  }

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

  // Access gate (mirrors /notify): admin / committee on committee task /
  // any roster member.
  const completerUids: string[] = Array.isArray(task.completerUids)
    ? (task.completerUids as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  const reviewerUids: string[] = Array.isArray(task.reviewerUids)
    ? (task.reviewerUids as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  const viewerOnTask =
    completerUids.includes(viewer.uid) || reviewerUids.includes(viewer.uid);
  const canAccess =
    viewer.role === "admin" ||
    (task.visibility === "committee" && viewer.role === "committee" && viewer.suRecognised) ||
    viewerOnTask;
  if (!canAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBlocks = Array.isArray(task.blocks) ? (task.blocks as unknown[]) : [];
  const block = rawBlocks.map(asBlockShape).find((b) => b && b.id === blockId);
  if (!block) {
    return NextResponse.json({ error: "Block not found" }, { status: 404 });
  }
  if (block.sealState !== "sealed") {
    return NextResponse.json(
      { error: "Block is not sealed yet. Lock in allocation first." },
      { status: 400 },
    );
  }

  const rawSubs = Array.isArray(task.subtasks) ? (task.subtasks as unknown[]) : [];
  const subs = rawSubs
    .map(asSubtaskShape)
    .filter((s): s is SubtaskShape => s !== null && s.blockId === blockId);
  const completion = subs.filter((s) => s.roleHint !== "reviewer");
  const signoffs = subs.filter((s) => s.roleHint === "reviewer");

  // Gate: every completion row has a terminal decision (approve OR reject —
  // no outstanding questions, no incomplete reviews) AND every signoff row
  // is ticked done. Mirrors the BlockHeader UI gate exactly.
  for (const s of completion) {
    if (s.questionedByReviewerUids.length > 0) {
      return NextResponse.json(
        {
          error: `"${s.title}" still has an outstanding question. Resolve it before sending the review.`,
        },
        { status: 400 },
      );
    }
    const required = new Set(s.reviewerUids);
    if (required.size === 0) continue; // no review gate on this row
    const fullyApproved =
      s.approvedByReviewerUids.length > 0 &&
      [...required].every((u) => s.approvedByReviewerUids.includes(u));
    const rejected = s.rejectedByReviewerUids.length > 0;
    if (!fullyApproved && !rejected) {
      return NextResponse.json(
        {
          error: `"${s.title}" hasn't reached a decision yet. Every reviewer needs to approve or reject.`,
        },
        { status: 400 },
      );
    }
  }
  if (signoffs.length === 0) {
    return NextResponse.json(
      { error: "No reviewer signoff rows on this block. Nothing to send." },
      { status: 400 },
    );
  }
  const allSignoffsDone = signoffs.every((s) => s.done);
  if (!allSignoffsDone) {
    return NextResponse.json(
      { error: "Every reviewer must tick their signoff row before sending the review." },
      { status: 400 },
    );
  }

  // Caller permission: admin OR a reviewer who has personally signed off on
  // this block. Mirrors the BlockHeader gate ("any signed-off-reviewer can
  // press").
  const viewerHasSignedOff = signoffs.some(
    (s) => s.reviewerUids.includes(viewer.uid) && s.done,
  );
  if (viewer.role !== "admin" && !viewerHasSignedOff) {
    return NextResponse.json(
      { error: "Only a signed-off reviewer (or an admin) can send the review outcome." },
      { status: 403 },
    );
  }

  // Activity-log scan: any subtask that was questioned during the current
  // review pass (since the previous reviewPassSentAt, or block.sealedAt for
  // the first pass) is a candidate for the questions-resolved bucket.
  const passStart = block.reviewPassSentAt ?? block.sealedAt;
  const questionedIds = new Set<string>();
  if (passStart) {
    const acts = await taskRef
      .collection("activity")
      .where("kind", "==", "subtask_questioned")
      .where("createdAt", ">=", Timestamp.fromDate(passStart))
      .get();
    for (const a of acts.docs) {
      const subId = (a.data().payload as DocumentData | undefined)?.subtaskId;
      if (typeof subId === "string") questionedIds.add(subId);
    }
  }

  // Pull the latest decision-note per subtask from the activity log so the
  // email can quote the reviewer's words. We grab approve/question/reject
  // entries and pick the most recent per subtaskId.
  const decisionActs = await taskRef
    .collection("activity")
    .where("kind", "in", ["subtask_approved", "subtask_questioned", "subtask_rejected"])
    .get();
  const latestNoteBySubtask = new Map<string, { at: number; note: string }>();
  for (const a of decisionActs.docs) {
    const data = a.data();
    const payload = (data.payload as DocumentData | undefined) ?? {};
    const subId = typeof payload.subtaskId === "string" ? payload.subtaskId : null;
    if (!subId) continue;
    const note = typeof payload.note === "string" ? payload.note : "";
    if (!note) continue;
    const ts = data.createdAt as { toMillis?: () => number } | undefined;
    const at = ts?.toMillis?.() ?? 0;
    const prev = latestNoteBySubtask.get(subId);
    if (!prev || at > prev.at) latestNoteBySubtask.set(subId, { at, note });
  }

  function noteFor(subtaskId: string): string {
    return truncate(latestNoteBySubtask.get(subtaskId)?.note ?? "", NOTE_MAX);
  }

  // Bucket completion rows. First-match wins so a subtask that was
  // questioned and ultimately rejected ends up in "rejected" — matches the
  // visual hierarchy in the UI.
  const approved: ReviewOutcomeSubtask[] = [];
  const questionsResolved: ReviewOutcomeSubtask[] = [];
  const rejected: ReviewOutcomeSubtask[] = [];
  for (const s of completion) {
    const isRejected = s.rejectedByReviewerUids.length > 0;
    if (isRejected) {
      rejected.push({ title: s.title, note: noteFor(s.id) });
      continue;
    }
    if (questionedIds.has(s.id)) {
      questionsResolved.push({ title: s.title, note: noteFor(s.id) });
      continue;
    }
    approved.push({ title: s.title, note: noteFor(s.id) });
  }

  // Recipients: every completer + every reviewer associated with this
  // pass (task-level reviewers + anyone who has a signoff row in this
  // block). Don't email the actor — they pressed the button.
  const recipientSet = new Set<string>(completerUids);
  for (const u of reviewerUids) recipientSet.add(u);
  for (const s of signoffs) for (const u of s.reviewerUids) recipientSet.add(u);
  recipientSet.delete(viewer.uid);
  const recipientList = Array.from(recipientSet);
  const users = await resolveUsers(db, recipientList);

  const taskTitle = typeof task.title === "string" ? task.title : "a task";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";
  const taskLink = `${appUrl}/committee/tasks?task=${encodeURIComponent(taskId)}`;

  let sent = 0;
  let failed = 0;
  let optedOut = 0;
  for (const uid of recipientList) {
    const user = users.get(uid);
    if (!user) {
      failed += 1;
      continue;
    }
    // THE THIRD GATE, AND IT GATES EMAIL ONLY. The site-wide
    // `config/taskEmails` kill switch ran at the top of the handler; this is
    // the member's own tasks row, the EMAIL column of it. The PUSH column is a
    // separate cell of the same row, and `mirrorTaskEmailToPush` reads it for
    // itself, so somebody who has said "notify me on my phone, not by email"
    // gets exactly that. Opted out is neither sent nor failed: nothing went
    // wrong, and nothing was posted.
    const wantsEmail = wantsEmailForProfile(user.profile, "tasks");
    try {
      if (wantsEmail) {
        await sendEmail({
          to: user.email,
          subject: `Review outcome: ${block.name} (${taskTitle})`,
          fromName: "NAISI Tasks",
          kind: "task",
          actorUid: viewer.uid,
          referenceId: taskId,
          react: TaskReviewOutcomeEmail({
            recipientName: user.displayName || "there",
            blockName: block.name,
            taskTitle,
            taskLink,
            approved,
            questionsResolved,
            rejected,
          }),
        });
        sent += 1;
      } else {
        optedOut += 1;
      }
      await mirrorTaskEmailToPush(uid, {
        title: `Review outcome: ${block.name}`,
        body: taskTitle,
        taskId,
      });
    } catch (err) {
      console.error(`[send-review-outcome] send to ${user.email} failed`, err);
      failed += 1;
    }
  }

  // Stamp `block.reviewPassSentAt` so the next pass scopes its
  // "questions-resolved" detection to events after this point. Re-reads the
  // doc to apply on the freshest blocks array — concurrent edits would
  // otherwise race the in-memory copy we validated against.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(taskRef);
    if (!fresh.exists) return;
    const data = fresh.data() ?? {};
    const blocks = Array.isArray(data.blocks) ? (data.blocks as unknown[]) : [];
    const next = blocks.map((b) => {
      if (!b || typeof b !== "object") return b;
      const obj = b as Record<string, unknown>;
      if (obj.id !== blockId) return b;
      return { ...obj, reviewPassSentAt: FieldValue.serverTimestamp() };
    });
    tx.update(taskRef, {
      blocks: next,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // Activity entry — descriptive past-tense, mirrors the naming convention
  // the user called out for Stage 5.
  await taskRef.collection("activity").add({
    kind: "review_outcome_sent",
    actorUid: viewer.uid,
    createdAt: FieldValue.serverTimestamp(),
    payload: {
      blockId,
      blockName: block.name,
      recipients: recipientList.length,
      approved: approved.length,
      questionsResolved: questionsResolved.length,
      rejected: rejected.length,
    },
  });

  return NextResponse.json({ ok: true, sent, failed, optedOut });
}
