/**
 * Task-email kill switch — a single Firestore doc at `config/taskEmails`
 * gates all task-related outbound mail (the `/api/tasks/.../notify` and
 * `/api/tasks/.../send-for-review` routes). Dev affordance so testers can
 * click through flows without spamming real inboxes. Not wired to other
 * pipelines (newsletter, auth, deliverability webhooks) — those must
 * continue to send regardless.
 *
 * Default when the doc is missing: enabled. Missing = green-light — we
 * don't want a vanilla repo / fresh Firestore project to silently drop
 * mail.
 */
import type { Firestore } from "firebase-admin/firestore";

export const TASK_EMAIL_CONFIG_PATH = {
  collection: "config",
  doc: "taskEmails",
} as const;

export type TaskEmailConfig = {
  enabled: boolean;
  updatedAt: Date | null;
  updatedByUid: string | null;
};

export async function readTaskEmailConfig(
  db: Firestore,
): Promise<TaskEmailConfig> {
  const snap = await db
    .collection(TASK_EMAIL_CONFIG_PATH.collection)
    .doc(TASK_EMAIL_CONFIG_PATH.doc)
    .get();
  if (!snap.exists) {
    return { enabled: true, updatedAt: null, updatedByUid: null };
  }
  const data = snap.data() ?? {};
  const enabled = typeof data.enabled === "boolean" ? data.enabled : true;
  const raw = data.updatedAt as { toDate?: () => Date } | null | undefined;
  const updatedAt =
    raw && typeof raw.toDate === "function" ? raw.toDate() : null;
  const updatedByUid =
    typeof data.updatedByUid === "string" ? data.updatedByUid : null;
  return { enabled, updatedAt, updatedByUid };
}

export async function isTaskEmailEnabled(db: Firestore): Promise<boolean> {
  const config = await readTaskEmailConfig(db);
  return config.enabled;
}
