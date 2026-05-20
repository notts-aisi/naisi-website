import { getAdminDb } from "@/lib/firebase/admin";
import { verifyToken, signToken } from "@/lib/signedTokens";
import { sendEmail } from "@/lib/email/send";
import { confirmAllForEmail } from "@/lib/firestore/subscriptions";
import SubscriptionWelcomeEmail from "@/emails/SubscriptionWelcomeEmail";

/**
 * Public-confirm landing page. Triggered by the link in the
 * `SubscriptionConfirmEmail`. Does NOT require auth — the signed token IS
 * the credential. On success: every `pending` row for the address gets
 * flipped to `confirmed`, and a welcome email is fired off.
 */

const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  if (!signed) {
    return htmlResponse(invalidPage("Missing token."), 400);
  }
  const payload = verifyToken(signed, "public-confirm");
  if (!payload || payload.s !== "public-confirm" || !payload.e) {
    return htmlResponse(invalidPage("This confirmation link is invalid or has expired."), 400);
  }

  const db = getAdminDb();
  if (!db) {
    return htmlResponse(invalidPage("Server not configured."), 500);
  }

  const email = payload.e;

  let result;
  try {
    result = await confirmAllForEmail(db, email, {
      kind: "guest",
      label: "email confirmation link",
    });
  } catch (err) {
    console.error("[/api/subscriptions/confirm] flip failed", email, err);
    return htmlResponse(invalidPage("Something went wrong confirming your subscription. Try again later."), 500);
  }

  // Pull a name off any subscription row for this email so the welcome
  // greeting can use it. Names live on the rows themselves (the name field
  // is captured at signup or written through by the sync route). One row
  // may have it and another may not (signups from different forms across
  // time), so just take the first non-empty one.
  let name: string | undefined;
  try {
    const rowsSnap = await db
      .collection("subscriptions")
      .where("email", "==", email)
      .get();
    for (const doc of rowsSnap.docs) {
      const candidate = doc.data().name;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        name = candidate.trim();
        break;
      }
    }
  } catch (err) {
    // Non-fatal. Welcome email just falls back to "Hi there".
    console.warn("[/api/subscriptions/confirm] name lookup failed", email, err);
  }

  // Welcome email is fire-and-forget so the success page renders even if the
  // send is slow / fails. Skip if there are no active channels (would mean
  // they were unsubscribed between sign-up and confirm; just render success
  // page so we don't leak signal).
  if (result.channels.length > 0) {
    void sendWelcomeEmail(email, result.channels, name).catch((err) => {
      console.warn("[/api/subscriptions/confirm] welcome send failed", email, err);
    });
  }

  return htmlResponse(successPage(result.channels), 200);
}

async function sendWelcomeEmail(
  email: string,
  channels: string[],
  name: string | undefined,
): Promise<void> {
  if (channels.length === 0) return;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const replyTo = process.env.EMAIL_DEFAULT_REPLY_TO;

  const unsubUrls: Record<string, string> = {};
  for (const channel of channels) {
    const tok = signToken(
      { s: "unsubscribe", email, c: channel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    unsubUrls[channel] = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(tok)}`;
  }
  const allTok = signToken(
    { s: "unsubscribe", email, c: "all" },
    UNSUB_TOKEN_TTL_SECONDS,
  );
  const unsubAllUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(allTok)}`;

  // Use the first channel's unsub-url for the RFC 8058 header. Inbox UIs
  // expose this as a single button, so it must drop the user from
  // *something* sensible. The footer in the email body offers per-channel
  // links explicitly.
  const headerUnsub = unsubUrls[channels[0]] ?? unsubAllUrl;

  await sendEmail({
    to: email,
    subject: "You're subscribed to NAISI",
    react: SubscriptionWelcomeEmail({
      channels,
      unsubUrls,
      unsubAllUrl,
      name,
    }),
    kind: "subscription-welcome",
    listUnsubscribe: { url: headerUnsub, mailto: replyTo },
  });
}

function successPage(channels: string[]): string {
  const channelLine = channels.length
    ? `You're now confirmed for: ${channels.map((c) => escapeHtml(prettyChannel(c))).join(", ")}.`
    : "You're confirmed.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Subscription confirmed · NAISI</title></head><body style="font-family: ui-sans-serif, system-ui; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.5;">
    <h1 style="margin-bottom: 12px;">Subscription confirmed</h1>
    <p style="color: #5b6785;">${channelLine} A welcome email is on its way with a one-click unsubscribe link for each list, in case you change your mind.</p>
    <p style="color: #5b6785; margin-top: 24px;"><a href="/" style="color: #3b55e3;">Back to naisi.uk</a></p>
  </body></html>`;
}

function invalidPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Confirmation · NAISI</title></head><body style="font-family: ui-sans-serif, system-ui; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.5;">
    <h1 style="margin-bottom: 12px;">This confirmation link didn't work</h1>
    <p style="color: #5b6785;">${escapeHtml(message)} If you're stuck, email us at <a href="mailto:ai-safety@uonsu.com" style="color: #3b55e3;">ai-safety@uonsu.com</a> and we'll sort it manually.</p>
  </body></html>`;
}

function prettyChannel(channel: string): string {
  if (channel === "newsletter") return "the newsletter";
  if (channel === "events") return "event announcements";
  return channel;
}
