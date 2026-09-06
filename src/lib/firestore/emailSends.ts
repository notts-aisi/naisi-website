import "server-only";
import type { Firestore } from "firebase-admin/firestore";

export type EmailSendKind =
  | "newsletter"
  | "broadcast"
  | "rsvp"
  | "task"
  | "application"
  | "application-test"
  | "course-application"
  // Staff-authored course mail (P9). Split three ways on purpose: the
  // deliverability tab's whole job is to answer "what did we send and who
  // sent it", and these three have different blast radii. `course-facilitator`
  // is operational mail to one small group; `course-broadcast` is an
  // announcement to a whole run's cohort channel; `course-test` is a rehearsal
  // that reached only its own sender. Collapsing them would make a 200-person
  // broadcast indistinguishable from a test send in the log.
  | "course-facilitator"
  | "course-broadcast"
  // The weekly course nudge (P11). Its own kind rather than folded into
  // `course-broadcast` because the two answer different questions in the
  // deliverability tab: a broadcast is a human deciding to write to a cohort,
  // a nudge is the recurring template that fires once per cohort week and is
  // built to be cronned. "Did the week 5 nudge go out?" has to be answerable
  // without reading subject lines, and a cohort's steady drip of nudges must
  // not drown out the announcements in the same view.
  //
  // There is deliberately no `course-nudge-test`: a rehearsal reaches only its
  // own sender whichever lane it rehearses, so the nudge route logs test sends
  // as `course-test` like the rest of the staff course mail. This kind means
  // mail that actually reached a cohort.
  | "course-nudge"
  // The room notice (V2-3, decision 8) — "we've moved to B52", "we're on Zoom
  // tonight". Its own kind, and NOT folded into `course-facilitator`, because
  // it is the one course lane that BYPASSES the `courses` opt-out: decision 8's
  // audit trail is these rows, and "how much un-opt-out-able mail did this
  // group send" has to be answerable without reading subject lines. It is also
  // the only kind keyed by GROUP rather than by run — `referenceId` is the
  // group id, which is what its 10-a-day cap is counted against.
  | "course-notice"
  // The enrolment lifecycle's own mail: today the drop-out confirmation. Kept
  // apart from `course-application` because that kind means the ADMISSIONS
  // funnel (applied, decided, placed) and this one means somebody joining or
  // leaving a run with no application behind it at all. "Did the person who
  // left get their confirmation" is a question the deliverability tab has to
  // answer without reading subject lines.
  | "course-enrolment"
  // The ADMISSIONS lifecycle (V3): everything NAISI sends somebody about their
  // application to a round. Kept apart from `course-application`, which means
  // the V2 per-run funnel this replaces, because the deliverability tab has to
  // answer "did the whole intake get its receipts" during the week an intake is
  // live, and mixing the two would make a round's mail unreadable next to the
  // legacy rows. Its `referenceId` is the ROUND id, not a run id: one round
  // feeds several runs and an appointment round feeds none.
  | "admissions"
  | "course-test"
  | "admin-test"
  | "subscription-confirm"
  | "subscription-welcome"
  | "subscription-added"
  | "unknown";

/**
 * `suppressed` is not a delivery outcome: it is the row for a message that was
 * never handed to the provider because the address is on `suppressedEmails`.
 * It exists so the deliverability tab can show what was WITHHELD next to what
 * was sent. Before the suppression check moved into `sendEmail` (see that
 * file's header) a withheld message left no trace at all, which made "why did
 * this member not get it" unanswerable from the log.
 *
 * `markSendStatus` only ever patches rows at `sent`, so a late bounce webhook
 * cannot land on one of these.
 */
export type EmailSendStatus = "sent" | "bounced" | "complained" | "suppressed";

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

/** What a withheld message can say about itself: everything but a provider id. */
export type LogSuppressedInput = Pick<
  EmailSend,
  "to" | "subject" | "fromEmail" | "fromName" | "kind"
> & {
  actorUid?: string;
  referenceId?: string;
  /** Why it was withheld, shown on the row. Defaults to the suppression list. */
  reason?: string;
  sentAt?: Date;
};

/**
 * Log a message that was NOT sent because its recipient is suppressed. Called
 * from `sendEmail()` once per dropped address, with the same kind, subject,
 * reference and actor the send would have carried, so a withheld message is as
 * legible in the deliverability tab as a delivered one.
 *
 * No `messageId`: nothing was handed to a provider, and writing a fake one
 * would give the webhook matcher something to find.
 */
export async function logSuppressedSend(db: Firestore, entry: LogSuppressedInput): Promise<void> {
  const at = entry.sentAt ?? new Date();
  const doc: Record<string, unknown> = {
    to: entry.to.trim(),
    subject: entry.subject,
    fromEmail: entry.fromEmail,
    fromName: entry.fromName,
    kind: entry.kind,
    status: "suppressed",
    statusReason: entry.reason ?? "on the suppression list",
    sentAt: at,
    statusUpdatedAt: at,
  };
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
