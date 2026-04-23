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
  /**
   * RFC 8058 one-click unsubscribe. Setting this adds the
   * `List-Unsubscribe` + `List-Unsubscribe-Post` headers that Gmail/Yahoo
   * require on bulk senders since Feb 2024 — and that give inbox clients
   * permission to render a prominent "unsubscribe" affordance.
   */
  listUnsubscribe?: {
    /** Must be a direct HTTPS URL that will accept a POST with empty body. */
    url: string;
    /** Optional mailto fallback for inbox clients that don't do one-click. */
    mailto?: string;
  };
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
  listUnsubscribe,
}: SendArgs) {
  const [html, text] = await Promise.all([render(react), render(react, { plainText: true })]);
  const displayName = fromName ?? process.env.SMTP_FROM_NAME ?? "NAISI";
  const fromEmail = process.env.SMTP_FROM_EMAIL ?? process.env.SMTP_USER;
  if (!fromEmail) throw new Error("SMTP_FROM_EMAIL or SMTP_USER must be set.");

  // Default Reply-To (e.g. a human-monitored inbox) so recipients who hit
  // "Reply" without noticing the Reply-To don't bounce into the void when the
  // From domain has no receiving MX. Per-call replyTo still wins.
  const effectiveReplyTo = replyTo ?? process.env.EMAIL_DEFAULT_REPLY_TO;

  const extraHeaders: Record<string, string> = {};
  if (listUnsubscribe) {
    const parts = [`<${listUnsubscribe.url}>`];
    if (listUnsubscribe.mailto) parts.push(`<mailto:${listUnsubscribe.mailto}>`);
    extraHeaders["List-Unsubscribe"] = parts.join(", ");
    extraHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const info = await transporter().sendMail({
    from: `"${displayName}" <${fromEmail}>`,
    to: Array.isArray(to) ? to.join(", ") : to,
    replyTo: effectiveReplyTo,
    subject,
    html,
    text,
    headers: extraHeaders,
  });

  // Pull SES's own message-id out of the 250 response so later bounce events
  // from SNS can link back to this exact row. Missing is fine — the row still
  // lands, just without the cross-link.
  const sesMessageId = parseSesMessageId(info.response);

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

  return { messageId: info.messageId, sesMessageId };
}
