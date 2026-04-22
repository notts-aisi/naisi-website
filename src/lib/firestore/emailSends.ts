import "server-only";
import type { Firestore } from "firebase-admin/firestore";

export type EmailSendKind =
  | "newsletter"
  | "broadcast"
  | "rsvp"
  | "task"
  | "application"
  | "application-test"
  | "admin-test"
  | "unknown";

export type EmailSendStatus = "sent" | "bounced" | "complained";

export type EmailSend = {
  messageId: string;
  sesMessageId?: string;
  to: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  kind: EmailSendKind;
  actorUid?: string;
  referenceId?: string;
  status: EmailSendStatus;
  sentAt: Date;
  statusUpdatedAt?: Date;
  statusReason?: string;
};

export type LogSendInput = Omit<EmailSend, "status" | "sentAt"> & {
  sentAt?: Date;
};

/**
 * Log a successful send. Called from `sendEmail()` after every successful
 * nodemailer response. Uses Firestore auto-ids — the webhook later looks up
 * rows by (sesMessageId, recipient) when a bounce/complaint arrives, so the
 * doc id itself doesn't need to be meaningful.
 */
export async function logEmailSend(db: Firestore, entry: LogSendInput): Promise<void> {
  const doc: Record<string, unknown> = {
    messageId: entry.messageId,
    to: entry.to,
    subject: entry.subject,
    fromEmail: entry.fromEmail,
    fromName: entry.fromName,
    kind: entry.kind,
    status: "sent",
    sentAt: entry.sentAt ?? new Date(),
  };
  if (entry.sesMessageId) doc.sesMessageId = entry.sesMessageId;
  if (entry.actorUid) doc.actorUid = entry.actorUid;
  if (entry.referenceId) doc.referenceId = entry.referenceId;
  await db.collection("emailSends").add(doc);
}

/**
 * Find the `emailSends` row for a specific (sesMessageId, recipient) pair and
 * update its status + reason. Called from the SNS webhook when a bounce or
 * complaint arrives — lets the UI show "bounced" against the specific
 * original send to that recipient, not every historical send to the address.
 *
 * A single `sesMessageId` can match multiple rows if the send was to multiple
 * recipients in one call, so filtering by recipient is what uniquely
 * identifies the row. Returns true iff a row was found and updated.
 */
export async function markSendStatus(
  db: Firestore,
  match: { sesMessageId: string; recipient: string },
  status: EmailSendStatus,
  reason?: string,
): Promise<boolean> {
  const snap = await db
    .collection("emailSends")
    .where("sesMessageId", "==", match.sesMessageId)
    .get();
  if (snap.empty) return false;
  const recipientLc = match.recipient.trim().toLowerCase();
  const hit = snap.docs.find(
    (d) => ((d.data().to as string | undefined) ?? "").toLowerCase() === recipientLc,
  );
  if (!hit) return false;
  const patch: Record<string, unknown> = {
    status,
    statusUpdatedAt: new Date(),
  };
  if (reason) patch.statusReason = reason;
  await hit.ref.update(patch);
  return true;
}
