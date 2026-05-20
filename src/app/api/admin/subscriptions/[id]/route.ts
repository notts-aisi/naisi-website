import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { getVerifiedEmails } from "@/lib/firestore/notifications";
import { deleteEventsForSubscriptions } from "@/lib/firestore/subscriptions";

/**
 * Admin-only hard-delete of a single subscription row, plus its event log.
 *
 * Deletable: guest rows (a guest is just an email, no account behind it),
 * and stale member rows (a member-audience row whose email is no longer
 * in the owning user's verified set, or whose owning user doc is gone).
 *
 * Protected: a LIVE member row, one for an email the owning user still
 * has verified. That must be unsubscribed, not deleted, so an admin can't
 * accidentally drop a real member subscription. Returns 409 in that case.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await getCurrentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Missing subscription id" }, { status: 400 });
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

  const data = snap.data() ?? {};
  const audience = data.audience;
  const email =
    typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const audienceId =
    typeof data.audienceId === "string" ? data.audienceId : "";

  // A live member row is protected: deleting it would silently drop a
  // real member's subscription, so it must be unsubscribed instead. Guest
  // rows, and stale member rows (de-verified email, or owning user gone),
  // fall through and are deletable.
  if (audience === "user" && audienceId) {
    const userSnap = await db.collection("users").doc(audienceId).get();
    if (userSnap.exists) {
      const u = userSnap.data() ?? {};
      const verified = getVerifiedEmails({
        email: typeof u.email === "string" ? u.email : null,
        profile: (u.profile ?? {}) as {
          universityEmail?: unknown;
          uniEmailVerifiedAt?: unknown;
        },
      }).map((e) => e.email);
      if (email && verified.includes(email)) {
        return NextResponse.json(
          {
            error:
              "This row is for a currently-verified email and is still live. Unsubscribe it instead of deleting.",
          },
          { status: 409 },
        );
      }
    }
  }

  await ref.delete();

  // Drop the row's event-log entries with it: the history lives exactly
  // as long as the row. Best-effort; the row itself is already gone.
  try {
    await deleteEventsForSubscriptions(db, [id]);
  } catch (err) {
    console.warn("[admin delete subscription] event cleanup failed", id, err);
  }

  return NextResponse.json({ ok: true, id });
}
