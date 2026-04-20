import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { render } from "@react-email/render";
import type { ReactElement } from "react";

type SendArgs = {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
  /** Override the display name in the From header (e.g. "NAISI Events"). */
  fromName?: string;
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

export async function sendEmail({ to, subject, react, replyTo, fromName }: SendArgs) {
  const [html, text] = await Promise.all([render(react), render(react, { plainText: true })]);
  const displayName = fromName ?? process.env.SMTP_FROM_NAME ?? "NAISI";
  const fromEmail = process.env.SMTP_FROM_EMAIL ?? process.env.SMTP_USER;
  if (!fromEmail) throw new Error("SMTP_FROM_EMAIL or SMTP_USER must be set.");

  const info = await transporter().sendMail({
    from: `"${displayName}" <${fromEmail}>`,
    to: Array.isArray(to) ? to.join(", ") : to,
    replyTo,
    subject,
    html,
    text,
  });

  return { messageId: info.messageId };
}
