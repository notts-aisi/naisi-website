import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ALL_CATEGORIES,
  type NotificationCategory,
} from "@/lib/firestore/notifications";

/**
 * Admin-only manual override on a single subscription row. Used by the
 * Subscriptions admin tab's per-row Deactivate / Re-activate buttons.
 *
 * Body: { status: "confirmed" | "unsubscribed" | "pending" }
 *
 * Stamps the corresponding timestamp field on transition:
 *  - "confirmed": sets `confirmedAt`, clears `unsubscribedAt`
 *  - "unsubscribed": sets `unsubscribedAt`
 *  - "pending": clears `confirmedAt` and `unsubscribedAt` (admin reset)
 *
 * Dual-write to the user doc when the row is owned by a member (audience
 * is "user") and the channel maps to a known legacy NotificationCategory
 * ("newsletter" or "events"). Without this, flipping a member's row from
 * the Subscriptions tab leaves `users/{uid}.profile.notifications.categories.<channel>`
 * stale, so the Members admin tab's toggle UI lies about the actual state
 * until cleanup. Migration window pattern, mirrors the inverse direction
 * already in place via adminMutations.setUserNotificationCategory.
 *
 * Re-activation is allowed on the principle that admin override is a
 * trust-the-admin operation. The row's own data plus the audit trail in
 * emailSends cover misuse. GDPR mandates honouring an unsubscribe;
 * nothing forbids reversal on an explicit user-or-admin ask.
 */

// Inline params shape — see sync-subscriptions/route.ts for the rationale.
type Ctx = { params: Promise<{ id: string }> };

type Body = {
  status?: unknown;
};

const VALID_STATUSES = new Set(["confirmed", "unsubscribed", "pending"]);

export async function POST(req: Request, ctx: Ctx) {
  const session = await getCurrentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Missing subscription id" }, { status: 400 });
  }

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const status = typeof parsed.status === "string" ? parsed.status : "";
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${Array.from(VALID_STATUSES).join(", ")}` },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const ref = db.collection("subscriptions").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  const now = Timestamp.now();
  const patch: Record<string, unknown> = { status };

  if (status === "confirmed") {
    patch.confirmedAt = now;
    // Clear any prior unsubscribed marker so the row reads cleanly. Use
    // FieldValue.delete via a sentinel — admin SDK's Timestamp module
    // exports it through a separate import path, so we just write null
    // here and let the row carry it. Sender + UI both treat
    // unsubscribedAt as "ignore unless status == 'unsubscribed'".
    patch.unsubscribedAt = null;
  } else if (status === "unsubscribed") {
    patch.unsubscribedAt = now;
  } else if (status === "pending") {
    patch.confirmedAt = null;
    patch.unsubscribedAt = null;
  }

  await ref.update(patch);

  // Dual-write the user doc legacy field when applicable. Reads the row
  // we just updated to pick up audience + channel.
  const data = snap.data() ?? {};
  const audience = data.audience;
  const channel = typeof data.channel === "string" ? data.channel : "";
  const audienceId = typeof data.audienceId === "string" ? data.audienceId : "";
  if (
    audience === "user" &&
    audienceId &&
    (ALL_CATEGORIES as string[]).includes(channel)
  ) {
    const cat = channel as NotificationCategory;
    // Map the new status onto the legacy boolean. "pending" is an
    // admin-reset state with no clear legacy equivalent, so we leave the
    // legacy field alone in that case.
    const legacyValue =
      status === "confirmed" ? true : status === "unsubscribed" ? false : null;
    if (legacyValue !== null) {
      const userPatch: Record<string, unknown> = {
        [`profile.notifications.categories.${cat}`]: legacyValue,
      };
      // Newsletter has the older single-bool field; events does not.
      if (cat === "newsletter") {
        userPatch["profile.newsletter.subscribed"] = legacyValue;
      }
      try {
        await db.collection("users").doc(audienceId).update(userPatch);
      } catch (err) {
        // Don't fail the row update if the user doc write fails; the row
        // is already correct, and a stale legacy field is a soft drift
        // we'll correct on the next sync. Log so it's visible in tail.
        console.warn("[set-status] user-doc legacy sync failed", audienceId, err);
      }
    }
  }

  return NextResponse.json({ ok: true, id, status });
}
