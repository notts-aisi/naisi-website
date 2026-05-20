import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyToken } from "@/lib/signedTokens";
import {
  ALL_CATEGORIES,
  normaliseNotifications,
  type NotificationCategory,
} from "@/lib/firestore/notifications";
import {
  channelLabel,
  isValidChannel,
  unsubscribe as unsubscribeChannel,
  unsubscribeAll as unsubscribeAllChannels,
  type SubscriptionActor,
} from "@/lib/firestore/subscriptions";

/**
 * One-click unsubscribe endpoint. Accepts a signed token, no auth needed
 * because the token's HMAC signature *is* the credential (only the real
 * recipient received it, and it expires).
 *
 * Brute-forcing the token isn't a real concern (HMAC-SHA256 over the
 * EVENTS_TOKEN_SECRET, ≥16-byte minimum, infeasible search space). What
 * IS a real concern is link prefetching: some mail clients, antivirus
 * scanners, and inbox preview bots fetch URLs in emails to scan them.
 * If the GET handler unsubscribed on click, those prefetchers would
 * silently unsubscribe the recipient before they ever opened the email.
 *
 * So:
 *   GET  → render a confirmation page with a single button. Pre-fetchers
 *          don't submit forms; they only see the confirmation HTML.
 *          The page shows an obfuscated email so the recipient can
 *          double-check which inbox they're dropping without leaking the
 *          full address (in case the email was forwarded somewhere).
 *   POST → actually perform the unsubscribe. Two callers:
 *           (a) RFC 8058 one-click POST from inbox-UI buttons (Gmail
 *               renders these for senders that include the
 *               List-Unsubscribe-Post header). Returns JSON.
 *           (b) Form submit from our own confirmation page. Returns HTML.
 *          Differentiated by `Accept: text/html`.
 *
 * The token's `c` field carries the channel id (`newsletter`, `events`,
 * future `cohort:fall-2026`, etc.) or the literal `"all"` for "drop me
 * from everything".
 */

type ResolvedTarget = {
  ok: true;
  /** Email shown obfuscated on the confirm page. */
  email: string;
  /** Channel id from the token (or "all"). */
  category: string;
};

type ResolveError = {
  ok: false;
  error: string;
  status: number;
};

/**
 * Validate the token and resolve the email being targeted, without
 * performing any state change. Used by the GET handler to render the
 * confirmation page.
 *
 * For email-based tokens (guest unsub) the email is in the token. For
 * uid-based tokens (member unsub) we fetch the user doc to read it.
 */
async function resolveTarget(
  signed: string | null,
): Promise<ResolvedTarget | ResolveError> {
  if (!signed) return { ok: false, error: "Missing token", status: 400 };
  const payload = verifyToken(signed, "unsubscribe");
  if (!payload || payload.s !== "unsubscribe") {
    return { ok: false, error: "Invalid or expired link", status: 400 };
  }

  const category = payload.c ?? "all";
  if (category !== "all" && !isValidChannel(category)) {
    return { ok: false, error: "Invalid channel", status: 400 };
  }

  const db = getAdminDb();
  if (!db) return { ok: false, error: "Server not configured", status: 500 };

  if (payload.email) {
    return { ok: true, email: payload.email, category };
  }
  if (payload.uid) {
    const snap = await db.collection("users").doc(payload.uid).get();
    if (!snap.exists) {
      // Don't expose user-not-found via a distinct status, but we also
      // can't render a confirmation page without an email to obfuscate.
      // Fall back to a generic placeholder and let the POST be a no-op.
      return { ok: true, email: "", category };
    }
    const data = snap.data() ?? {};
    const email = typeof data.email === "string" ? data.email : "";
    return { ok: true, email, category };
  }

  return { ok: false, error: "Token is missing a subject", status: 400 };
}

/**
 * Mutating path: perform the unsubscribe, dual-write user-doc legacy
 * fields when applicable. Same logic as the prior single GET-or-POST
 * handler, factored out so GET (preview) and POST (commit) can call it
 * separately.
 */
async function performUnsubscribe(signed: string | null): Promise<{
  ok: boolean;
  category?: string;
  error?: string;
  status: number;
}> {
  if (!signed) return { ok: false, error: "Missing token", status: 400 };
  const payload = verifyToken(signed, "unsubscribe");
  if (!payload || payload.s !== "unsubscribe") {
    return { ok: false, error: "Invalid or expired link", status: 400 };
  }

  const db = getAdminDb();
  if (!db) return { ok: false, error: "Server not configured", status: 500 };

  const category = payload.c ?? "all";
  if (category !== "all" && !isValidChannel(category)) {
    return { ok: false, error: "Invalid channel", status: 400 };
  }

  // An email-link click is sessionless; the signed token is the credential.
  const actor: SubscriptionActor = {
    kind: "guest",
    label: "unsubscribe email link",
  };

  if (payload.uid) {
    const ref = db.collection("users").doc(payload.uid);
    const snap = await ref.get();
    if (!snap.exists) {
      // Swallow as success. Exposing "user not found" via a distinct
      // status is an enumeration signal we don't want.
      return { ok: true, category, status: 200 };
    }
    const profile = (snap.data()?.profile ?? {}) as Record<string, unknown>;
    const userEmail = (snap.data()?.email as string | undefined) ?? null;
    const uniEmail =
      (profile.universityEmail as string | undefined) ?? null;
    const current = normaliseNotifications(profile);
    const nextCategories = { ...current.categories };

    const knownCategoriesToFlip: NotificationCategory[] =
      category === "all"
        ? ALL_CATEGORIES.slice()
        : (ALL_CATEGORIES as NotificationCategory[]).includes(category as NotificationCategory)
          ? [category as NotificationCategory]
          : [];
    for (const c of knownCategoriesToFlip) nextCategories[c] = false;

    await ref.update({
      "profile.notifications.categories": nextCategories,
      "profile.newsletter.subscribed":
        category === "all" || category === "newsletter"
          ? false
          : (profile.newsletter as { subscribed?: boolean } | undefined)?.subscribed ??
            false,
    });

    if (userEmail) {
      if (category === "all") await unsubscribeAllChannels(db, userEmail, actor);
      else
        await unsubscribeChannel(db, {
          email: userEmail,
          channel: category,
          actor,
        });
    }
    if (uniEmail && uniEmail !== userEmail) {
      if (category === "all") await unsubscribeAllChannels(db, uniEmail, actor);
      else
        await unsubscribeChannel(db, {
          email: uniEmail,
          channel: category,
          actor,
        });
    }

    return { ok: true, category, status: 200 };
  }

  if (payload.email) {
    if (category === "all") {
      await unsubscribeAllChannels(db, payload.email, actor);
    } else {
      await unsubscribeChannel(db, {
        email: payload.email,
        channel: category,
        actor,
      });
    }
    return { ok: true, category, status: 200 };
  }

  return { ok: false, error: "Token is missing a subject", status: 400 };
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * `marie.smith@example.com` → `m**th@example.com`.
 * `ab@example.com` → `a**b@example.com` (last 1 char when local has 2).
 * `x@example.com` → `x**@example.com` (no last chars when local has 1).
 * Empty / malformed → `***@***`.
 */
function obfuscateEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1) return "***@***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length === 1) return `${local}**${domain}`;
  if (local.length === 2) return `${local[0]}**${local[1]}${domain}`;
  return `${local[0]}**${local.slice(-2)}${domain}`;
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
 * GET: render a confirmation page with the obfuscated email and a single
 * "Confirm unsubscribe" button. The button posts back to the same URL.
 * Pre-fetchers and link scanners only get this page; they don't submit
 * the form, so no unsubscribe happens until the recipient explicitly
 * clicks.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  const target = await resolveTarget(signed);

  if (!target.ok) {
    return htmlResponse(invalidPage(target.error), target.status);
  }

  const obfuscated = obfuscateEmail(target.email);
  const scopeLabel = channelLabel(target.category);
  // Reuse the same `?t=` token in the form action so the POST handler
  // can verify and act on the same signed payload.
  const formAction = `/api/unsubscribe?t=${encodeURIComponent(signed!)}`;

  return htmlResponse(`<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Unsubscribe · NAISI</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.55; }
    h1 { margin-bottom: 12px; font-size: 24px; }
    p { color: #5b6785; margin: 0 0 16px; }
    .email { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #1a2032; }
    form { margin-top: 28px; }
    button { background: #3b55e3; color: #fff; border: 0; padding: 12px 22px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; }
    button:hover { background: #2c43c4; }
    .cancel { display: inline-block; margin-left: 12px; color: #5b6785; text-decoration: underline; }
  </style>
</head><body>
  <h1>Unsubscribe?</h1>
  <p>You're about to unsubscribe <span class="email">${escapeHtml(obfuscated)}</span> from ${escapeHtml(scopeLabel)}. We won't send any more to that inbox.</p>
  <p>If this isn't your email or you didn't expect to be here, just close the page. Nothing happens until you click the button below.</p>
  <form method="POST" action="${escapeHtml(formAction)}">
    <button type="submit">Confirm unsubscribe</button>
    <a class="cancel" href="/">Cancel</a>
  </form>
</body></html>`);
}

/**
 * POST: do the unsubscribe.
 *  - From an inbox UI (RFC 8058 one-click): no Accept: text/html header,
 *    we return JSON.
 *  - From our own confirmation form (browser): Accept: text/html, we
 *    render a thank-you HTML page.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  const result = await performUnsubscribe(signed);

  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");

  if (!result.ok) {
    if (wantsHtml) {
      return htmlResponse(invalidPage(result.error ?? "Unknown error"), result.status);
    }
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (!wantsHtml) {
    return NextResponse.json({ ok: true, category: result.category });
  }

  const scopeLabel = result.category ? channelLabel(result.category) : "these messages";
  return htmlResponse(`<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Unsubscribed · NAISI</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.55; }
    h1 { margin-bottom: 12px; font-size: 24px; }
    p { color: #5b6785; margin: 0 0 16px; }
    a { color: #3b55e3; }
  </style>
</head><body>
  <h1>You're unsubscribed from ${escapeHtml(scopeLabel)}.</h1>
  <p>We won't send any more to this inbox. If you change your mind, you can re-enable delivery from your <a href="/profile">profile page</a> (members) or by re-subscribing on the homepage (guests).</p>
  <p>Made a mistake, or want to stop other NAISI emails too? <a href="mailto:ai-safety@uonsu.com">Email us</a>.</p>
</body></html>`);
}

function invalidPage(message: string): string {
  return `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Unsubscribe · NAISI</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.55; }
    h1 { margin-bottom: 12px; font-size: 24px; }
    p { color: #5b6785; margin: 0 0 16px; }
    a { color: #3b55e3; }
  </style>
</head><body>
  <h1>This unsubscribe link didn't work.</h1>
  <p>${escapeHtml(message)}. If you're still getting email, reply to the most recent one and we'll remove you manually.</p>
</body></html>`;
}
