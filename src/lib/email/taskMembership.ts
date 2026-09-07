import "server-only";
import type { DocumentData, Firestore } from "firebase-admin/firestore";
import type { MembershipPreassignment } from "@/emails/TaskMembershipEmail";

/**
 * Server-side helpers for the membership email pipeline (Stage 5,
 * 2026-04-26). Shared between the batch /send-initial-notifications route
 * and the per-uid /notify-member route so the email body is identical
 * across both surfaces.
 */

export type ResolvedUser = {
  email: string;
  displayName: string;
  /**
   * The raw stored profile, carried so the caller's send loop can ask
   * `wantsEmailForProfile` about the tasks row without a second read.
   *
   * It is the CALLER that asks, not this resolver. The row check belongs
   * beside the send it suppresses, where a reader of that loop can see the
   * three gates in series; a resolver that quietly dropped opted-out members
   * would leave every one of those loops looking ungated.
   */
  profile: unknown;
};

export async function resolveTaskUsers(
  db: Firestore,
  uids: string[],
): Promise<Map<string, ResolvedUser>> {
  const out = new Map<string, ResolvedUser>();
  const filtered = uids.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (filtered.length === 0) return out;
  const refs = filtered.map((uid) => db.collection("users").doc(uid));
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

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((u): u is string => typeof u === "string");
}

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function formatDueLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Build the per-recipient personalisation slice of a membership email
 * (preassignments + other completer names) directly from the task doc as
 * read by the Admin SDK. Doing the projection here means the API route
 * stays slim and the email payload is consistent across send paths.
 */
export function buildMembershipEmailPayload({
  recipientUid,
  task,
  users,
}: {
  recipientUid: string;
  task: DocumentData;
  users: Map<string, ResolvedUser>;
}): {
  preassignments: MembershipPreassignment[];
  otherCompleterNames: string[];
} {
  const completerUids = stringArray(task.completerUids);
  const otherCompleterNames: string[] = [];
  for (const uid of completerUids) {
    if (uid === recipientUid) continue;
    const u = users.get(uid);
    if (!u) continue;
    otherCompleterNames.push(u.displayName);
  }
  const preassignments: MembershipPreassignment[] = [];
  const subtasks = Array.isArray(task.subtasks) ? (task.subtasks as unknown[]) : [];
  for (const raw of subtasks) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const roleHint = s.roleHint;
    if (roleHint === "reviewer") continue; // signoff rows aren't pre-assignments
    const assignees = stringArray(s.assigneeUids);
    if (!assignees.includes(recipientUid)) continue;
    const title = typeof s.title === "string" ? s.title : "Untitled subtask";
    const due = tsToDate(s.dueDate);
    preassignments.push({
      title,
      dueLabel: due ? formatDueLabel(due) : "",
    });
  }
  return { preassignments, otherCompleterNames };
}
