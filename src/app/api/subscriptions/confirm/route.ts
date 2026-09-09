import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyToken, signToken } from "@/lib/signedTokens";
import { sendEmail } from "@/lib/email/send";
import { confirmAllForEmail } from "@/lib/firestore/subscriptions";
import SubscriptionWelcomeEmail from "@/emails/SubscriptionWelcomeEmail";

/**
 * Public double-opt-in confirmation for a subscription. Triggered by the link in
 * `SubscriptionConfirmEmail`. No auth: the signed token IS the credential.
 *
 * GET is a PREVIEW, POST is the MUTATION — the same split the sibling
 * unsubscribe route makes, and for the same reason. Some mail clients,
 * antivirus scanners and inbox preview bots FETCH the links in an email to scan
 * them; a GET that confirmed on fetch would let such a prefetch complete a
 * double-opt-in the recipient never performed (and, once confirmed, every later
 * unsubscribe they do is undoable through the public subscribe endpoint). So:
 *   GET  → verify the token and render a single-button confirmation page. A
 *          prefetcher sees only HTML and never submits the form.
 *   POST → verify the token and run `confirmAllForEmail` (flip pending rows to
 *          confirmed, reactivate any queued re-subscribe, send the welcome
 *          email). Reached only by a real click of the button, or an inbox-UI
 *          one-click POST.
 * Guard: tests/get-handlers-readonly.test.mjs (no GET handler under /api mutates).
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

/**
 * Verify the token WITHOUT any state change, returning the address it names.
 * Used by GET to render the preview and by POST before it mutates.
 */
function resolveEmail(
  signed: string | null,
): { ok: true; email: string } | { ok: false; error: string; status: number } {
  if (!signed) return { ok: false, error: "Missing token.", status: 400 };
  const payload = verifyToken(signed, "public-confirm");
  if (!payload || payload.s !== "public-confirm" || !payload.e) {
    return {
      ok: false,
      error: "This confirmation link is invalid or has expired.",
      status: 400,
    };
  }
  return { ok: true, email: payload.e };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  const resolved = resolveEmail(signed);
  if (!resolved.ok) {
    return htmlResponse(invalidPage(resolved.error), resolved.status);
  }

  // Reuse the same `?t=` token in the form action so POST verifies the same
  // signed payload. Pre-fetchers only render this page; nothing is confirmed
  // until the recipient clicks the button.
  const formAction = `/api/subscriptions/confirm?t=${encodeURIComponent(signed!)}`;
  return htmlResponse(confirmPage(formAction));
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  const resolved = resolveEmail(signed);

  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  if (!resolved.ok) {
    if (wantsHtml) return htmlResponse(invalidPage(resolved.error), resolved.status);
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const db = getAdminDb();
  if (!db) {
    if (wantsHtml) return htmlResponse(invalidPage("Server not configured."), 500);
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const email = resolved.email;

  let result;
  try {
    result = await confirmAllForEmail(db, email, {
      kind: "guest",
      label: "email confirmation link",
    });
  } catch (err) {
    console.error("[/api/subscriptions/confirm] flip failed", email, err);
    if (wantsHtml) {
      return htmlResponse(
        invalidPage("Something went wrong confirming your subscription. Try again later."),
        500,
      );
    }
    return NextResponse.json({ error: "Confirmation failed" }, { status: 500 });
  }

  // Pull a name off any subscription row for this email so the welcome
  // greeting can use it. Names live on the rows themselves; take the first
  // non-empty one.
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
  // send is slow / fails. Skip if there are no active channels.
  if (result.channels.length > 0) {
    void sendWelcomeEmail(email, result.channels, name).catch((err) => {
      console.warn("[/api/subscriptions/confirm] welcome send failed", email, err);
    });
  }

  if (!wantsHtml) {
    return NextResponse.json({ ok: true, channels: result.channels });
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

function confirmPage(formAction: string): string {
  return `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Confirm your subscription · NAISI</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.55; }
    h1 { margin-bottom: 12px; font-size: 24px; }
    p { color: #5b6785; margin: 0 0 16px; }
    form { margin-top: 28px; }
    button { background: #3b55e3; color: #fff; border: 0; padding: 12px 22px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; }
    button:hover { background: #2c43c4; }
    .cancel { display: inline-block; margin-left: 12px; color: #5b6785; text-decoration: underline; }
  </style>
</head><body>
  <h1>Confirm your subscription</h1>
  <p>Click the button below to confirm you'd like to hear from NAISI at this address. Nothing is sent until you confirm.</p>
  <p>If you didn't sign up, just close this page. Nothing happens until you click the button.</p>
  <form method="POST" action="${escapeHtml(formAction)}">
    <button type="submit">Confirm subscription</button>
    <a class="cancel" href="/">Cancel</a>
  </form>
</body></html>`;
}

function successPage(channels: string[]): string {
  const channelLine = channels.length
    ? `You're now confirmed for: ${channels.map((c) => escapeHtml(prettyChannel(c))).join(", ")}.`
    : "You're confirmed.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Subscription confirmed · NAISI</title></head><body style="font-family: ui-sans-serif, system-ui; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.5;">
    <h1 style="margin-bottom: 12px;">Subscription confirmed</h1>
    <p style="color: #5b6785;">${channelLine} A welcome email is on its way with a one-click unsubscribe link for each list, in case you change your mind.</p>
    <p style="color: #5b6785; margin-top: 24px;"><a href="/" style="color: #3b55e3;">Back to naisi.uk</a></p>
  </body></html>`;
}

function invalidPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Confirmation · NAISI</title></head><body style="font-family: ui-sans-serif, system-ui; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.5;">
    <h1 style="margin-bottom: 12px;">This confirmation link didn't work</h1>
    <p style="color: #5b6785;">${escapeHtml(message)} If you're stuck, email us at <a href="mailto:ai-safety@uonsu.com" style="color: #3b55e3;">ai-safety@uonsu.com</a> and we'll sort it manually.</p>
  </body></html>`;
}

function prettyChannel(channel: string): string {
  if (channel === "newsletter") return "the newsletter";
  if (channel === "events") return "event announcements";
  return channel;
}
