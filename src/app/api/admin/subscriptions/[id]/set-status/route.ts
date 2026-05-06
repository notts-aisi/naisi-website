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
 * Subscriptions admin tab's per-row Unsubscribe / Re-subscribe buttons.
 *
 * Body: { subscribed: boolean }
 *
 * - subscribed=true:  sets subscribed=true, stamps subscribedAt. Doesn't
 *   touch confirmed; if the row was unconfirmed it remains unconfirmed
 *   (which is the right behaviour for an admin "yes they want this list"
 *   override on a not-yet-confirmed row).
 * - subscribed=false: sets subscribed=false, stamps unsubscribedAt.
 *
 * Dual-write to the user doc when the row is owned by a member (audience
 * is "user") and the channel maps to a known legacy NotificationCategory.
 * `profile.notifications.categories.<channel>` is the field the legacy
 * sender + useNewsletterSubscribers + bounce webhooks still consult. Soft
 * drift on a multi-email user when only one row is flipped is accepted
 * for this PR; the follow-up cleanup PR moves the sender to row-level
 * addressing and drops the legacy field with no replacement here.
 */

type Ctx = { params: Promise<{ id: string }> };

type Body = {
  subscribed?: unknown;
};

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

  if (typeof parsed.subscribed !== "boolean") {
    return NextResponse.json(
      { error: "Body must include `subscribed` (boolean)." },
      { status: 400 },
    );
  }
  const subscribed = parsed.subscribed;

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
  const patch: Record<string, unknown> = { subscribed };
  if (subscribed) {
    patch.subscribedAt = now;
    // Don't clear unsubscribedAt; it stays as audit ("they unsubscribed at
    // time T, then admin re-subscribed them at time U"). UI derives current
    // state from the boolean, not from the timestamps.
  } else {
    patch.unsubscribedAt = now;
  }

  await ref.update(patch);

  // Dual-write the user doc legacy notification field when applicable.
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
    const userPatch: Record<string, unknown> = {
      [`profile.notifications.categories.${cat}`]: subscribed,
    };
    // Newsletter has the older single-bool field; events does not.
    if (cat === "newsletter") {
      userPatch["profile.newsletter.subscribed"] = subscribed;
    }
    try {
      await db.collection("users").doc(audienceId).update(userPatch);
    } catch (err) {
      // Don't fail the row update if the user doc write fails. The row
      // is already correct; stale legacy field is a soft drift the next
      // sync will correct.
      console.warn("[set-status] user-doc legacy sync failed", audienceId, err);
    }
  }

  return NextResponse.json({ ok: true, id, subscribed });
}
