import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { getVerifiedEmails } from "@/lib/firestore/notifications";

/**
 * Admin-only hard-delete of a single subscription row.
 *
 * Scoped deliberately to STALE rows only: a member-audience row whose
 * email is no longer in the owning user's verified-email set (a ghost
 * left behind when a uni email changed, was un-verified, or a guest row
 * was claimed onto the account), or a row whose owning user doc is gone.
 *
 * It refuses to delete a row that is still live, so an admin can't
 * accidentally nuke a real subscription from the table. To stop delivery
 * on a live row, use the Unsubscribe action instead, which keeps the row
 * and its audit trail.
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

  // Only member-audience rows are "stale" in the orphan sense. A guest
  // row is identified by its email and is a genuine subscriber record,
  // not a ghost; it isn't deletable through this path.
  if (audience !== "user" || !audienceId) {
    return NextResponse.json(
      {
        error:
          "Only stale member rows can be deleted here. Guest rows are not removable from this view.",
      },
      { status: 409 },
    );
  }

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
  // userSnap missing => the owning user is gone; the row is orphaned and
  // safe to delete.

  await ref.delete();
  return NextResponse.json({ ok: true, id });
}
