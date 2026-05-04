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
  | "subscription-confirm"
  | "subscription-welcome"
  | "subscription-added"
  | "unknown";

export type EmailSendStatus = "sent" | "bounced" | "complained";

export type EmailSend = {
  messageId: string;
  // Provider message ids — only one is populated per row, depending on which
  // SMTP server the send went through. `sesMessageId` is the historical path
  // (AWS SES); `resendEmailId` is the current path (Resend). Keep both
  // optional so either handler can match rows without schema branching.
  sesMessageId?: string;
  resendEmailId?: string;
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
 * nodemailer response. Uses Firestore auto-ids — the webhook later finds
 * rows by (provider id, recipient) or a recency fallback when a bounce /
 * complaint arrives, so the doc id itself doesn't need to be meaningful.
 */
export async function logEmailSend(db: Firestore, entry: LogSendInput): Promise<void> {
  const doc: Record<string, unknown> = {
    messageId: entry.messageId,
    // Trim the recipient on write — dirty inputs (e.g. trailing space in a
    // user's stored email) break (recipient, id) lookups in markSendStatus
    // even though the mail itself delivers fine. Trimming at write + at
    // comparison gives us belt-and-braces.
    to: entry.to.trim(),
    subject: entry.subject,
    fromEmail: entry.fromEmail,
    fromName: entry.fromName,
    kind: entry.kind,
    status: "sent",
    sentAt: entry.sentAt ?? new Date(),
  };
  if (entry.sesMessageId) doc.sesMessageId = entry.sesMessageId;
  if (entry.resendEmailId) doc.resendEmailId = entry.resendEmailId;
  if (entry.actorUid) doc.actorUid = entry.actorUid;
  if (entry.referenceId) doc.referenceId = entry.referenceId;
  await db.collection("emailSends").add(doc);
}

export type MarkSendStatusMatch = {
  recipient: string;
  sesMessageId?: string;
  resendEmailId?: string;
};

const FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_SCAN_LIMIT = 200;

function sentAtMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v === "object" && typeof (v as { toDate?: () => Date }).toDate === "function") {
    try {
      return (v as { toDate: () => Date }).toDate().getTime();
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Find the `emailSends` row corresponding to an incoming webhook event and
 * patch its status + reason. Match strategy in order of preference:
 *   1. Provider id (sesMessageId or resendEmailId) + recipient — exact match.
 *      A single provider id can cover multiple recipients in a batch send, so
 *      the recipient filter is what uniquely identifies the row.
 *   2. Fallback: the most recent `sent` row for this recipient within the
 *      last 7 days. Used when the provider doesn't surface a parseable id at
 *      send time (e.g. Resend's SMTP 250 line may not include the UUID).
 *      Low-volume use case; the race where two rapid sends to the same
 *      recipient confuse the match is effectively zero here.
 * Returns true iff a row was found and updated.
 */
export async function markSendStatus(
  db: Firestore,
  match: MarkSendStatusMatch,
  status: EmailSendStatus,
  reason?: string,
): Promise<boolean> {
  const recipientLc = match.recipient.trim().toLowerCase();
  if (!recipientLc) return false;

  let hit: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  if (match.sesMessageId || match.resendEmailId) {
    const field = match.sesMessageId ? "sesMessageId" : "resendEmailId";
    const value = match.sesMessageId ?? match.resendEmailId;
    const snap = await db
      .collection("emailSends")
      .where(field, "==", value)
      .get();
    hit = snap.docs.find(
      (d) => ((d.data().to as string | undefined) ?? "").trim().toLowerCase() === recipientLc,
    );
  }

  if (!hit) {
    const cutoffMs = Date.now() - FALLBACK_LOOKBACK_MS;
    const snap = await db
      .collection("emailSends")
      .orderBy("sentAt", "desc")
      .limit(FALLBACK_SCAN_LIMIT)
      .get();
    hit = snap.docs.find((d) => {
      const data = d.data();
      if (data.status !== "sent") return false;
      if (((data.to as string | undefined) ?? "").trim().toLowerCase() !== recipientLc) return false;
      return sentAtMs(data.sentAt) >= cutoffMs;
    });
  }

  if (!hit) {
    console.warn("[markSendStatus] no match", {
      recipient: recipientLc,
      sesMessageId: match.sesMessageId ?? null,
      resendEmailId: match.resendEmailId ?? null,
      targetStatus: status,
    });
    return false;
  }

  console.log("[markSendStatus] matched row", hit.id, "for", recipientLc, "→", status);

  const patch: Record<string, unknown> = {
    status,
    statusUpdatedAt: new Date(),
  };
  if (reason) patch.statusReason = reason;
  await hit.ref.update(patch);
  return true;
}
