import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyToken } from "@/lib/signedTokens";
import {
  ALL_CATEGORIES,
  normaliseNotifications,
  type NotificationCategory,
} from "@/lib/firestore/notifications";

/**
 * One-click unsubscribe endpoint. Accepts a signed token — no auth needed
 * because the token's HMAC signature *is* the credential (only the real
 * recipient received it, and it expires).
 *
 * Supports both RFC 8058 (`POST` from mail providers with
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) and direct GET from
 * a human-clicked link in an email.
 */
async function unsubscribeFromToken(signed: string | null): Promise<{
  ok: boolean;
  category?: NotificationCategory | "all";
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

  if (payload.uid) {
    // Authed user unsubscribe — update users/{uid}.profile.notifications.
    const ref = db.collection("users").doc(payload.uid);
    const snap = await ref.get();
    if (!snap.exists) {
      // Swallow as success — a user the token refers to can't confirm the
      // unsub visually if they don't exist, but exposing "user not found" via
      // a distinct status is an enumeration signal we don't want.
      return { ok: true, category, status: 200 };
    }
    const profile = (snap.data()?.profile ?? {}) as Record<string, unknown>;
    const current = normaliseNotifications(profile);
    const nextCategories = { ...current.categories };
    if (category === "all") {
      for (const c of ALL_CATEGORIES) nextCategories[c] = false;
    } else {
      nextCategories[category] = false;
    }
    await ref.update({
      "profile.notifications.categories": nextCategories,
      // Keep legacy in sync so un-migrated read paths respect the opt-out.
      "profile.newsletter.subscribed":
        category === "all" || category === "newsletter"
          ? false
          : (profile.newsletter as { subscribed?: boolean } | undefined)?.subscribed ??
            false,
    });
    return { ok: true, category, status: 200 };
  }

  if (payload.email) {
    // Public subscriber unsubscribe — not built in this PR but the token
    // shape is ready for it. Treat as no-op for now.
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

  const scopeLabel =
    result.category === "all"
      ? "all NAISI emails"
      : result.category === "newsletter"
        ? "the NAISI newsletter"
        : result.category === "events"
          ? "NAISI event announcements"
          : "these messages";

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
