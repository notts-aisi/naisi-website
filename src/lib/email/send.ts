import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  logEmailSend,
  type EmailSendKind,
} from "@/lib/firestore/emailSends";
import { parseSesMessageId } from "./sesMessageId";
import { parseResendMessageId } from "./resendMessageId";

type SendArgs = {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
  /** Override the display name in the From header (e.g. "NAISI Events"). */
  fromName?: string;
  /** Category for the deliverability dashboard. Defaults to 'unknown'. */
  kind?: EmailSendKind;
  /** Uid of the admin / committee member who triggered this send, if any. */
  actorUid?: string;
  /** Related entity id (draft id, event id, RSVP id) for cross-referencing. */
  referenceId?: string;
};

let cached: Transporter | null = null;

function transporter(): Transporter {
  if (cached) return cached;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) {
    throw new Error(
      "SMTP is not configured — set SMTP_HOST, SMTP_USER, SMTP_PASSWORD in the environment.",
    );
  }
  cached = nodemailer.createTransport({
    host,
    port,
    // Gmail requires STARTTLS on 587; implicit TLS only on 465.
    secure: port === 465,
    auth: { user, pass },
  });
  return cached;
}

export async function sendEmail({
  to,
  subject,
  react,
  replyTo,
  fromName,
  kind,
  actorUid,
  referenceId,
}: SendArgs) {
  const [html, text] = await Promise.all([render(react), render(react, { plainText: true })]);
  const displayName = fromName ?? process.env.SMTP_FROM_NAME ?? "NAISI";
  const fromEmail = process.env.SMTP_FROM_EMAIL ?? process.env.SMTP_USER;
  if (!fromEmail) throw new Error("SMTP_FROM_EMAIL or SMTP_USER must be set.");

  // Default Reply-To (e.g. a human-monitored inbox) so recipients who hit
  // "Reply" without noticing the Reply-To don't bounce into the void when the
  // From domain has no receiving MX. Per-call replyTo still wins.
  const effectiveReplyTo = replyTo ?? process.env.EMAIL_DEFAULT_REPLY_TO;

  const info = await transporter().sendMail({
    from: `"${displayName}" <${fromEmail}>`,
    to: Array.isArray(to) ? to.join(", ") : to,
    replyTo: effectiveReplyTo,
    subject,
    html,
    text,
  });

  // Pull the provider's own message id out of the 250 response so later
  // bounce/complaint events can link back to this exact row. The two parsers
  // are mutually exclusive in practice (one matches, the other returns
  // undefined) — the webhook handler tolerates both being absent via a
  // recipient + recency fallback.
  const sesMessageId = parseSesMessageId(info.response);
  const resendEmailId = parseResendMessageId(info.response);

  // Log the send to Firestore. Swallow failures: a missing dashboard entry
  // is never worth failing the caller's API request over.
  const recipients = Array.isArray(to) ? to : [to];
  const db = getAdminDb();
  if (db) {
    await Promise.all(
      recipients.map((addr) =>
        logEmailSend(db, {
          messageId: info.messageId,
          sesMessageId,
          resendEmailId,
          to: addr,
          subject,
          fromEmail,
          fromName: displayName,
          kind: kind ?? "unknown",
          actorUid,
          referenceId,
        }).catch((err) => {
          console.warn("[sendEmail] failed to log to emailSends", err);
        }),
      ),
    );
  }

  return { messageId: info.messageId, sesMessageId, resendEmailId };
}
