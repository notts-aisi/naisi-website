import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normaliseEmail } from "@/lib/firestore/emailDocId";
import {
  ALL_CATEGORIES,
  type NotificationCategory,
} from "@/lib/firestore/notifications";
import {
  claimGuestSubscriptions,
  subscribe,
  unsubscribe,
} from "@/lib/firestore/subscriptions";

/**
 * Admin-only counterpart to /api/subscriptions/sync. Operates on an
 * arbitrary uid (the regular sync route only handles the session user).
 *
 * Used by `adminMutations.ts` after every admin write that touches a
 * member's notification prefs — keeps the `subscriptions` junction
 * collection in lockstep with the legacy `users.profile.notifications`
 * field during the migration window.
 *
 * Body shape: { prefs?: { newsletter: boolean, events: boolean } }
 *  - If `prefs` is provided, applied as deltas (most-recent-action wins,
 *    same semantics as the user-facing sync route).
 *  - If `prefs` is omitted, the route reads the target user's current
 *    user-doc prefs and syncs from those — useful for a "make it consistent
 *    with whatever's on the user doc right now" call.
 */

// `RouteContext<"...">` would be tighter but requires Next's typegen to
// have run since the path was added. Inline the params shape so this
// route compiles cleanly on a fresh checkout before the first dev server
// or build refreshes `.next/types/routes.d.ts`.
type Ctx = { params: Promise<{ uid: string }> };

type Body = {
  prefs?: { newsletter?: unknown; events?: unknown };
};

export async function POST(req: Request, ctx: Ctx) {
  const session = await getCurrentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { uid } = await ctx.params;
  if (!uid) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  const maybeDb = getAdminDb();
  if (!maybeDb) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  const db = maybeDb;

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const userData = userSnap.data() ?? {};
  const profile = (userData.profile as Record<string, unknown> | undefined) ?? {};
  const googleEmail = normaliseEmail(
    typeof userData.email === "string" ? userData.email : "",
  );
  if (!googleEmail) {
    return NextResponse.json(
      { error: "User has no email on record" },
      { status: 400 },
    );
  }
  const uniRaw = profile.universityEmail;
  const uniEmail =
    typeof uniRaw === "string" && uniRaw.trim().length > 0
      ? normaliseEmail(uniRaw)
      : null;

  // Pull the member's preferred / display name through to the row so the
  // admin Subscriptions table shows the human label, and so any future
  // outbound that personalises by name has it available without an
  // extra user-doc read at send time.
  const preferred = profile.preferredName;
  const display = userData.displayName;
  const memberName: string | undefined =
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    undefined;

  let parsed: Body = {};
  try {
    parsed = (await req.json()) as Body;
  } catch {
    // Body is optional — treat missing as "sync from user doc".
    parsed = {};
  }

  let wantedByCategory: Record<NotificationCategory, boolean>;
  if (parsed.prefs && (parsed.prefs.newsletter !== undefined || parsed.prefs.events !== undefined)) {
    wantedByCategory = {
      newsletter: Boolean(parsed.prefs.newsletter),
      events: Boolean(parsed.prefs.events),
    };
  } else {
    // Fall back to the user doc's current state. Reading the same
    // categories via the existing normaliser keeps legacy-shape users
    // tolerated.
    const { normaliseNotifications } = await import(
      "@/lib/firestore/notifications"
    );
    const current = normaliseNotifications(profile);
    wantedByCategory = {
      newsletter: current.categories.newsletter,
      events: current.categories.events,
    };
  }

  // Claim any guest rows that match this user's email(s). Idempotent.
  try {
    await claimGuestSubscriptions(db, { email: googleEmail, uid });
    if (uniEmail && uniEmail !== googleEmail) {
      await claimGuestSubscriptions(db, { email: uniEmail, uid });
    }
  } catch (err) {
    console.warn("[admin sync-subscriptions] claim failed", uid, err);
  }

  // Apply deltas onto the user's primary (Google) email. Same routing
  // model the sender uses: one row per (user, channel) keyed on Google
  // email; per-address fan-out happens at send time via addressesForSend.
  for (const cat of ALL_CATEGORIES) {
    if (wantedByCategory[cat]) {
      await subscribe(db, {
        email: googleEmail,
        channel: cat,
        audience: "user",
        audienceId: uid,
        source: "admin",
        name: memberName,
      });
    } else {
      await unsubscribe(db, { email: googleEmail, channel: cat });
    }
  }

  return NextResponse.json({ ok: true });
}
