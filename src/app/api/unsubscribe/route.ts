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
} from "@/lib/firestore/subscriptions";

/**
 * One-click unsubscribe endpoint. Accepts a signed token — no auth needed
 * because the token's HMAC signature *is* the credential (only the real
 * recipient received it, and it expires).
 *
 * Supports both RFC 8058 (`POST` from mail providers with
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) and direct GET from
 * a human-clicked link in an email.
 *
 * Token's `c` field carries the channel id (`newsletter`, `events`, future
 * `cohort:fall-2026`, etc.) or the literal `"all"` for "drop me from
 * everything". The `c` field is a free string by design so cohort channels
 * added after PR 1 work without a token-shape change.
 */
async function unsubscribeFromToken(signed: string | null): Promise<{
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
  // Allow only valid channels or the literal "all". Tokens minted before this
  // PR may carry "newsletter"/"events" — both pass `isValidChannel`.
  if (category !== "all" && !isValidChannel(category)) {
    return { ok: false, error: "Invalid channel", status: 400 };
  }

  if (payload.uid) {
    // Authed user unsubscribe — flip the subscription row(s) AND keep the
    // legacy `users/{uid}.profile.notifications.categories` field in sync
    // during the migration window. The sender already reads from
    // `subscriptions`, but other code paths may still consult the user-doc
    // booleans until the legacy-cleanup PR.
    const ref = db.collection("users").doc(payload.uid);
    const snap = await ref.get();
    if (!snap.exists) {
      // Swallow as success — exposing "user not found" via a distinct status
      // is an enumeration signal we don't want.
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

    // Subscription rows: members may have rows under their primary (google)
    // email AND/OR uni email. Flip whichever matches.
    if (userEmail) {
      if (category === "all") await unsubscribeAllChannels(db, userEmail);
      else await unsubscribeChannel(db, { email: userEmail, channel: category });
    }
    if (uniEmail && uniEmail !== userEmail) {
      if (category === "all") await unsubscribeAllChannels(db, uniEmail);
      else await unsubscribeChannel(db, { email: uniEmail, channel: category });
    }

    return { ok: true, category, status: 200 };
  }

  if (payload.email) {
    // Guest subscriber unsubscribe — directly flip the subscription row(s).
    if (category === "all") {
      await unsubscribeAllChannels(db, payload.email);
    } else {
      await unsubscribeChannel(db, { email: payload.email, channel: category });
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

/** RFC 8058 one-click POST from mail clients. Body may be empty. */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  const result = await unsubscribeFromToken(signed);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, category: result.category });
}

/** Human-clicked link from an email. Renders a confirmation page. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const signed = url.searchParams.get("t");
  const result = await unsubscribeFromToken(signed);

  if (!result.ok) {
    return htmlResponse(
      `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe · NAISI</title></head><body style="font-family: ui-sans-serif, system-ui; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.5;">
        <h1 style="margin-bottom: 12px;">This unsubscribe link didn't work</h1>
        <p style="color: #5b6785;">${escapeHtml(result.error ?? "Unknown error")}. If you're still getting email, reply to the most recent one and we'll remove you manually.</p>
      </body></html>`,
      result.status,
    );
  }

  const scopeLabel = result.category ? channelLabel(result.category) : "these messages";

  return htmlResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed · NAISI</title></head><body style="font-family: ui-sans-serif, system-ui; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a2032; line-height: 1.5;">
      <h1 style="margin-bottom: 12px;">You're unsubscribed from ${escapeHtml(scopeLabel)}</h1>
      <p style="color: #5b6785;">We won't send any more to this inbox. If you change your mind, you can re-enable delivery from your <a href="/profile" style="color: #3b55e3;">profile page</a>.</p>
      <p style="color: #5b6785; margin-top: 24px;">Made a mistake, or want to stop other NAISI emails too? <a href="mailto:ai-safety@uonsu.com" style="color: #3b55e3;">Email us</a>.</p>
    </body></html>`,
    200,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
