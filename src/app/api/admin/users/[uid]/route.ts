import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { deleteAccountCascade } from "@/lib/firestore/accountDeletion";

type Ctx = { params: Promise<{ uid: string }> };

/**
 * Hard-delete a user by uid (admin-only) via the shared account cascade:
 * subscriptions + their event log, the registrations tracker row, any
 * collaborators doc, the users doc, and the Firebase Auth account.
 *
 * Substantive content (tasks / comments / attachments / events / RSVPs /
 * bookings) is intentionally retained — that's the deferred hygiene sweep; see
 * the scope note on `deleteAccountCascade`.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { uid } = await ctx.params;
  if (!uid) {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }
  if (uid === actor.uid) {
    return NextResponse.json(
      { error: "You can't delete yourself. Ask another admin." },
      { status: 400 },
    );
  }

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  try {
    const summary = await deleteAccountCascade(auth, db, uid);
    return NextResponse.json(
      { ok: true, ...summary },
      summary.warning ? { status: 207 } : undefined,
    );
  } catch (err) {
    console.error("[admin delete] cascade failed:", uid, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 },
    );
  }
}
