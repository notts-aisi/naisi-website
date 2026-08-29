import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/firebase/session";
import { isPushConfigured } from "@/lib/push/config";
import { upsertSubscription } from "@/lib/push/store";

/*
 * Stores (or refreshes) a device's push subscription for the signed-in
 * member. Called from PushSettings on enable, and again on every mount as a
 * re-sync: Safari iOS never fires pushsubscriptionchange, so re-asserting
 * the current subscription whenever the app opens is the only way lastSeenAt
 * and the uid claim stay honest.
 *
 * Members only. A push subscription is a channel to a device's lock screen;
 * pending and rejected accounts have no business holding one.
 */
export async function POST(request: NextRequest) {
  if (!isPushConfigured()) {
    return NextResponse.json({ error: "Push is not configured" }, { status: 503 });
  }
  const user = await getCurrentUser();
  if (!user || user.role === "pending" || user.role === "rejected") {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const sub = (body as { subscription?: unknown })?.subscription as
    | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
    | undefined;
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    !sub.endpoint.startsWith("https://") ||
    typeof sub.keys?.p256dh !== "string" ||
    typeof sub.keys?.auth !== "string"
  ) {
    return NextResponse.json({ error: "Bad subscription" }, { status: 400 });
  }

  const ok = await upsertSubscription({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    uid: user.uid,
    userAgent: request.headers.get("user-agent") ?? undefined,
  });
  if (!ok) return NextResponse.json({ error: "Store unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true });
}
